export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_LOGS       = process.env.NOTION_DB_LOGS;
  const DB_STUDENTS   = process.env.NOTION_DB_STUDENTS;

  if (!NOTION_TOKEN || !DB_LOGS || !DB_STUDENTS) {
    return res.status(500).json({ error: 'Vercel 환경변수가 설정되지 않았습니다.' });
  }

  const data = req.body;

  const notionHeaders = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  // ── 기간 내 학생별 기록 건수 (보고서 현황용) ──
  if (data.action === 'get_record_counts') {
    try {
      let all = [], cursor;
      do {
        const body = {
          filter: {
            and: [
              { property: '날짜', date: { on_or_after: data.start } },
              { property: '날짜', date: { on_or_before: data.end } },
            ]
          },
          page_size: 100
        };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_LOGS}/query`, {
          method: 'POST', headers: notionHeaders, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.object === 'error') throw new Error(d.message);
        all = all.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      const counts = {};
      all.forEach(p => {
        const name = p.properties['이름']?.rich_text?.[0]?.text?.content || '';
        if (!name) return;
        counts[name] = (counts[name] || 0) + 1;
      });
      return res.status(200).json({ ok: true, counts });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── 특정 날짜의 전체 기록 조회 (일괄 입력 프리필용) ──
  // ── 기간 내 학생별 기록 병합 (월간 일괄입력 프리필용) ──
  if (data.action === 'get_range_records') {
    try {
      let all = [], cursor;
      do {
        const body = {
          filter: { and: [
            { property: '날짜', date: { on_or_after: data.start } },
            { property: '날짜', date: { on_or_before: data.end } },
          ]},
          sorts: [{ property: '날짜', direction: 'ascending' }],
          page_size: 100
        };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_LOGS}/query`, {
          method: 'POST', headers: notionHeaders, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.object === 'error') throw new Error(d.message);
        all = all.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      // 학생별로 여러 날 기록을 과목별로 합침 (중복 제거, ' / '로 연결)
      const merged = {};
      all.forEach(p => {
        const name = p.properties['이름']?.rich_text?.[0]?.text?.content || '';
        if (!name) return;
        const g = f => (p.properties[f]?.rich_text?.[0]?.text?.content || '').trim();
        if (!merged[name]) merged[name] = { word:[], grammar:[], reading:[], listening:[], writing:[], note:[] };
        const fields = { word:'단어', grammar:'문법', reading:'독해', listening:'듣기', writing:'라이팅', note:'특이사항' };
        for (const [k, kr] of Object.entries(fields)) {
          const v = g(kr);
          if (v && !merged[name][k].includes(v)) merged[name][k].push(v);
        }
      });

      // 배열 → 문자열
      const records = {};
      for (const [name, obj] of Object.entries(merged)) {
        records[name] = {};
        for (const k of Object.keys(obj)) records[name][k] = obj[k].join(' / ');
      }
      return res.status(200).json({ ok: true, records });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (data.action === 'get_day_records') {
    try {
      let all = [], cursor;
      do {
        const body = {
          filter: { property: '날짜', date: { equals: data.date } },
          page_size: 100
        };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_LOGS}/query`, {
          method: 'POST', headers: notionHeaders, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.object === 'error') throw new Error(d.message);
        all = all.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      const records = {};
      all.forEach(p => {
        const name = p.properties['이름']?.rich_text?.[0]?.text?.content || '';
        if (!name) return;
        records[name] = {
          word:      p.properties['단어']?.rich_text?.[0]?.text?.content || '',
          grammar:   p.properties['문법']?.rich_text?.[0]?.text?.content || '',
          reading:   p.properties['독해']?.rich_text?.[0]?.text?.content || '',
          listening: p.properties['듣기']?.rich_text?.[0]?.text?.content || '',
          writing:   p.properties['라이팅']?.rich_text?.[0]?.text?.content || '',
          note:      p.properties['특이사항']?.rich_text?.[0]?.text?.content || '',
        };
      });
      return res.status(200).json({ ok: true, records });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!data.name) return res.status(400).json({ error: '이름이 없습니다.' });

  try {
    // 1. 학생 페이지 찾거나 생성
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_STUDENTS}/query`, {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify({
        filter: { and: [
          { property: '학생이름', title: { equals: data.name } },
          { property: '구분', select: { equals: data.type } }
        ]}
      })
    });
    const searchData = await searchRes.json();

    let studentPageId;
    if (searchData.results && searchData.results.length > 0) {
      studentPageId = searchData.results[0].id;
    } else {
      const emoji = data.type === '초등' ? '🌱' : data.type === '중등' ? '📖' : '🎓';
      const newStudent = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: DB_STUDENTS },
          icon: { type: 'emoji', emoji },
          properties: {
            '학생이름': { title: [{ text: { content: data.name } }] },
            '구분':     { select: { name: data.type } },
            '학년':     { select: { name: data.grade } }
          },
          children: [
            { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '📋 학습 기록' } }] } },
            { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '수업 기록이 자동으로 추가됩니다.' }, annotations: { color: 'gray' } }] } },
            { object: 'block', type: 'divider', divider: {} }
          ]
        })
      });
      const newStudentData = await newStudent.json();
      studentPageId = newStudentData.id;
    }

    // 2. 학습기록 DB에 행 추가 (같은 날짜+이름 있으면 덮어쓰기)
    const subjects = ['word','grammar','reading','listening','writing']
      .filter(k => data[k])
      .map(k => ({ word:'단어', grammar:'문법', reading:'독해', listening:'듣기', writing:'라이팅' }[k]))
      .join(' · ');
    const title = `${data.name} — ${subjects || '수업기록'} (${data.date})`;

    const logProps = {
      '':         { title: [{ text: { content: title } }] },
      '날짜':     { date: { start: data.date } },
      '구분':     { select: { name: data.type } },
      '학년':     { select: { name: data.grade } },
      '이름':     { rich_text: [{ text: { content: data.name } }] },
      '단어':     { rich_text: [{ text: { content: data.word || '' } }] },
      '문법':     { rich_text: [{ text: { content: data.grammar || '' } }] },
      '독해':     { rich_text: [{ text: { content: data.reading || '' } }] },
      '듣기':     { rich_text: [{ text: { content: data.listening || '' } }] },
      '라이팅':   { rich_text: [{ text: { content: data.writing || '' } }] },
      '특이사항': { rich_text: [{ text: { content: data.note || '' } }] }
    };

    // 같은 이름+날짜 기록 검색
    const dupRes = await fetch(`https://api.notion.com/v1/databases/${DB_LOGS}/query`, {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({
        filter: { and: [
          { property: '이름', rich_text: { equals: data.name } },
          { property: '날짜', date: { equals: data.date } },
        ]}
      })
    });
    const dupData = await dupRes.json();
    const existingPage = dupData.results?.[0];
    const existingId = existingPage?.id;

    // 업데이트 시: 새 값이 비어있으면 기존 값 유지 (덮어쓰기로 지워지지 않도록)
    if (existingId) {
      const getField = f => existingPage.properties[f]?.rich_text?.[0]?.text?.content || '';
      const merge = (newVal, field) => (newVal && newVal.trim()) ? newVal : getField(field);

      const mergedWord      = merge(data.word,      '단어');
      const mergedGrammar   = merge(data.grammar,   '문법');
      const mergedReading   = merge(data.reading,   '독해');
      const mergedListening = merge(data.listening, '듣기');
      const mergedWriting   = merge(data.writing,   '라이팅');
      const mergedNote      = merge(data.note,      '특이사항');

      const mergedSubjects = [
        mergedWord&&'단어', mergedGrammar&&'문법', mergedReading&&'독해',
        mergedListening&&'듣기', mergedWriting&&'라이팅'
      ].filter(Boolean).join(' · ');

      logProps[''] = { title: [{ text: { content: `${data.name} — ${mergedSubjects || '수업기록'} (${data.date})` } }] };
      logProps['단어']     = { rich_text: [{ text: { content: mergedWord } }] };
      logProps['문법']     = { rich_text: [{ text: { content: mergedGrammar } }] };
      logProps['독해']     = { rich_text: [{ text: { content: mergedReading } }] };
      logProps['듣기']     = { rich_text: [{ text: { content: mergedListening } }] };
      logProps['라이팅']   = { rich_text: [{ text: { content: mergedWriting } }] };
      logProps['특이사항'] = { rich_text: [{ text: { content: mergedNote } }] };
    }

    let logData;
    if (existingId) {
      // 기존 기록 업데이트 (빈 칸은 기존 값 유지)
      const upRes = await fetch(`https://api.notion.com/v1/pages/${existingId}`, {
        method: 'PATCH', headers: notionHeaders,
        body: JSON.stringify({ properties: logProps })
      });
      logData = await upRes.json();
    } else {
      // 신규 추가
      const logRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST', headers: notionHeaders,
        body: JSON.stringify({ parent: { database_id: DB_LOGS }, properties: logProps })
      });
      logData = await logRes.json();
    }
    if (logData.object === 'error') throw new Error(logData.message);

    // 3. 학생 개별 페이지에 블록 추가 (신규 기록일 때만 — 업데이트 시 중복 방지)
    if (!existingId) {
      const lines = [
        data.word      && `📝 단어: ${data.word}`,
        data.grammar   && `📐 문법: ${data.grammar}`,
        data.reading   && `📖 독해: ${data.reading}`,
        data.listening && `🎧 듣기: ${data.listening}`,
        data.writing   && `✍️ 라이팅: ${data.writing}`,
        data.note      && `💬 메모: ${data.note}`
      ].filter(Boolean);

      await fetch(`https://api.notion.com/v1/blocks/${studentPageId}/children`, {
        method: 'PATCH',
        headers: notionHeaders,
        body: JSON.stringify({
          children: [
            { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: `📅 ${data.date}  (${data.grade})` }, annotations: { bold: true } }] } },
            ...lines.map(l => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: l } }] } })),
            { object: 'block', type: 'divider', divider: {} }
          ]
        })
      });
    }

    return res.status(200).json({ ok: true, message: existingId ? '✅ 기존 기록 업데이트 완료!' : '✅ 노션에 저장 완료!' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
