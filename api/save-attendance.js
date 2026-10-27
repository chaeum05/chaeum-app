export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_ATTENDANCE = process.env.NOTION_DB_ATTENDANCE;

  if (!NOTION_TOKEN || !DB_ATTENDANCE) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action, name, type, grade, date, status, memo, recordId, absentDate } = body;

  try {
    if (action === 'upsert') {
      // 날짜 equals 대신 on_or_after + on_or_before 사용 (timezone 이슈 방지)
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '학생이름', rich_text: { equals: name } },
              { property: '날짜',     date: { on_or_after:  date } },
              { property: '날짜',     date: { on_or_before: date } },
              { property: '구분',     select: { equals: type } },
              { property: '학년',     select: { equals: grade } },
            ]
          }
        })
      });
      const searchData = await searchRes.json();
      const title = `${name} — ${status} (${date})`;

      if (searchData.results && searchData.results.length > 0) {
        const existingId = searchData.results[0].id;
        await fetch(`https://api.notion.com/v1/pages/${existingId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            properties: {
              '기록제목': { title: [{ text: { content: title } }] },
              '출결상태': { select: { name: status } },
              '메모':     { rich_text: [{ text: { content: memo || '' } }] },
              ...(absentDate ? { '원래날짜': { date: { start: absentDate } } } : {})
            }
          })
        });
        // 중복 기록 정리
        for (let i = 1; i < searchData.results.length; i++) {
          await fetch(`https://api.notion.com/v1/pages/${searchData.results[i].id}`, {
            method: 'PATCH', headers,
            body: JSON.stringify({ archived: true })
          });
        }
        return res.status(200).json({ ok: true, message: '출결 기록 업데이트 완료' });
      } else {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({
            parent: { database_id: DB_ATTENDANCE },
            properties: {
              '기록제목':  { title: [{ text: { content: title } }] },
              '날짜':      { date: { start: date } },
              '학생이름':  { rich_text: [{ text: { content: name } }] },
              '구분':      { select: { name: type } },
              '학년':      { select: { name: grade } },
              '출결상태':  { select: { name: status } },
              '메모':      { rich_text: [{ text: { content: memo || '' } }] },
              ...(absentDate ? { '원래날짜': { date: { start: absentDate } } } : {})
            }
          })
        });
        return res.status(200).json({ ok: true, message: '출결 기록 저장 완료' });
      }
    }

    // 특정 날짜 보강 기록 삭제
    if (action === 'delete_by_date') {
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '날짜', date: { equals: date } },
            { property: '출결상태', select: { equals: status || '보강' } }
          ]}
        })
      });
      const searchData = await searchRes.json();
      for (const page of (searchData.results || [])) {
        await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ archived: true })
        });
      }
      return res.status(200).json({ ok: true, message: '삭제 완료' });
    }

    // 보강 대기 삭제
    if (action === 'delete_makeup' && recordId) {
      await fetch(`https://api.notion.com/v1/pages/${recordId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true })
      });
      return res.status(200).json({ ok: true, message: '보강 대기 삭제 완료' });
    }

    // 보강 완료 처리
    if (action === 'complete_makeup' && recordId) {
      await fetch(`https://api.notion.com/v1/pages/${recordId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({
          properties: {
            '출결상태': { select: { name: '보강완료' } },
            '원래날짜': { date: { start: absentDate || date } },
            '날짜':     { date: { start: date } },
          }
        })
      });
      return res.status(200).json({ ok: true, message: '보강 완료 처리되었습니다.' });
    }

    // 등원 일정 저장 (학생 스케줄 등록)
    if (action === 'save_schedule') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      const { days, school, teacher, period, startDate } = body; // { 월: true, ... }, 학교명, 담임, 수업부, 등록일

      // 기존 스케줄 찾기
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '학생이름', title: { equals: name } },
              { property: '구분', select: { equals: type } }
            ]
          }
        })
      });
      const searchData = await searchRes.json();
      if (searchData.object === 'error') throw new Error('등원일정 조회 실패: ' + searchData.message);

      const props = {
        '학생이름': { title: [{ text: { content: name } }] },
        '구분':     { select: { name: type } },
        '학년':     { select: { name: grade } },
        '월': { checkbox: days['월'] || false },
        '화': { checkbox: days['화'] || false },
        '수': { checkbox: days['수'] || false },
        '목': { checkbox: days['목'] || false },
        '금': { checkbox: days['금'] || false },
        '메모': { rich_text: [{ text: { content: memo || '' } }] }
      };
      // 학교는 입력됐을 때만 (기존 값 안 지우도록)
      if (school) props['학교'] = { rich_text: [{ text: { content: school } }] };
      // 담임도 선택됐을 때만: 기본 담임 + 등원하는 요일에만 담임 세팅
      if (teacher) {
        props['담임'] = { select: { name: teacher } };
        ['월','화','수','목','금'].forEach(d => {
          // 등원 요일이면 담임 지정, 아니면 비움(기존 값 제거)
          props[`담임_${d}`] = days[d] ? { select: { name: teacher } } : { select: null };
        });
      }

      // 수업부(1부/2부)도 선택됐을 때만: 기본 + 등원 요일에만
      if (period === '1부' || period === '2부') {
        props['수업부'] = { select: { name: period } };
        ['월','화','수','목','금'].forEach(d => {
          props[`수업부_${d}`] = days[d] ? { select: { name: period } } : { select: null };
        });
      }

      // 등록일: 새 학생이면 넣고, 이미 있는 학생은 등록일이 비어 있을 때만 (기존 등록일은 안 바꿈)
      const existingPage = searchData.results?.[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') && !existingPage?.properties?.['등록일']?.date?.start) {
        props['등록일'] = { date: { start: startDate } };
      }

      let saveRes;
      if (searchData.results && searchData.results.length > 0) {
        saveRes = await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ properties: props })
        });
      } else {
        saveRes = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({ parent: { database_id: DB_SCHEDULE }, properties: props })
        });
      }
      const saveData = await saveRes.json();
      if (saveData.object === 'error') throw new Error('등원일정 저장 실패: ' + saveData.message);

      return res.status(200).json({ ok: true, message: '등원 일정 저장 완료' });
    }

    // 🕕 요일별 수업부 지정 (출결 화면의 1부/2부 칩)
    if (action === 'set_period') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      const { day, period } = body;
      if (!['월','화','수','목','금'].includes(day)) return res.status(400).json({ error: '요일이 올바르지 않아요.' });
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { and: [
          { property: '학생이름', title: { equals: name } },
          { property: '구분', select: { equals: type } }
        ]}})
      });
      const searchData = await searchRes.json();
      if (searchData.object === 'error') throw new Error(searchData.message);
      const page = searchData.results?.[0];
      if (!page) return res.status(404).json({ error: '등원일정에서 학생을 찾지 못했어요.' });
      const val = (period === '1부' || period === '2부') ? { select: { name: period } } : { select: null };
      const props = { [`수업부_${day}`]: val };
      // 기본 수업부가 비어 있으면 같이 채워 둠 (다른 화면 표시용)
      if (val.select && !page.properties['수업부']?.select?.name) props['수업부'] = val;
      const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ properties: props })
      });
      const d = await r.json();
      if (d.object === 'error') throw new Error(d.message);
      return res.status(200).json({ ok: true });
    }

    // 🎫 수업 형태 (정규 / 회차)
    if (action === 'set_lesson_type') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      const q = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { and: [
          { property: '학생이름', title: { equals: name } },
          { property: '구분', select: { equals: type } }
        ]}})
      });
      const qd = await q.json();
      if (qd.object === 'error') throw new Error(qd.message);
      const page = qd.results?.[0];
      if (!page) return res.status(404).json({ error: '등원일정에서 학생을 찾지 못했어요.' });
      const v = body.lessonType === '회차' ? { select: { name: '회차' } } : { select: { name: '정규' } };
      const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, { method: 'PATCH', headers, body: JSON.stringify({ properties: { '수업형태': v } }) });
      const d = await r.json();
      if (d.object === 'error') throw new Error(d.message);
      return res.status(200).json({ ok: true });
    }

    // 📖 교재 목록 (학원 교재 카탈로그)
    if (action === 'list_books' || action === 'save_book' || action === 'delete_book') {
      const DB_BOOKS = process.env.NOTION_DB_BOOKS || '53209d1a69c84234bb890d61d0f81b3b';
      const SUBJ = { word: '단어', grammar: '문법', reading: '독해', listening: '듣기', writing: '라이팅', naesin: '내신' };
      const REV = Object.fromEntries(Object.entries(SUBJ).map(([k, v]) => [v, k]));
      const toBook = p => ({
        id: p.id,
        b: (p.properties['교재명']?.title || []).map(t => t.plain_text ?? t.text?.content ?? '').join('').trim(),
        subj: (p.properties['과목']?.multi_select || []).map(o => REV[o.name]).filter(Boolean),
        u: (p.properties['단위']?.rich_text || []).map(t => t.plain_text ?? t.text?.content ?? '').join('').trim(),
        t: p.properties['전체분량']?.number ?? '',
        memo: (p.properties['메모']?.rich_text || []).map(t => t.plain_text ?? t.text?.content ?? '').join('').trim(),
      });
      if (action === 'list_books') {
        let all = [], cursor;
        do {
          const q = { page_size: 100, sorts: [{ property: '교재명', direction: 'ascending' }] };
          if (cursor) q.start_cursor = cursor;
          const r = await fetch(`https://api.notion.com/v1/databases/${DB_BOOKS}/query`, { method: 'POST', headers, body: JSON.stringify(q) });
          const d = await r.json();
          if (d.object === 'error') throw new Error('교재 목록을 못 읽었어요: ' + d.message);
          all = all.concat(d.results || []);
          cursor = d.has_more ? d.next_cursor : undefined;
        } while (cursor);
        return res.status(200).json({ ok: true, books: all.map(toBook).filter(x => x.b) });
      }
      if (action === 'delete_book') {
        if (!body.id) return res.status(400).json({ error: '교재 id가 필요해요.' });
        const r = await fetch(`https://api.notion.com/v1/pages/${body.id}`, { method: 'PATCH', headers, body: JSON.stringify({ archived: true }) });
        const d = await r.json();
        if (d.object === 'error') throw new Error(d.message);
        return res.status(200).json({ ok: true });
      }
      // save_book: { book: { id?, b, subj:[], u, t, memo } }
      const bk = body.book || {};
      if (!String(bk.b || '').trim()) return res.status(400).json({ error: '교재 이름이 필요해요.' });
      const props = {
        '교재명': { title: [{ text: { content: String(bk.b).trim() } }] },
        '과목': { multi_select: (bk.subj || []).filter(k => SUBJ[k]).map(k => ({ name: SUBJ[k] })) },
        '단위': { rich_text: bk.u ? [{ text: { content: String(bk.u) } }] : [] },
        '전체분량': { number: bk.t === '' || bk.t === null || bk.t === undefined ? null : Number(bk.t) },
        '메모': { rich_text: bk.memo ? [{ text: { content: String(bk.memo) } }] : [] },
      };
      const r = bk.id
        ? await fetch(`https://api.notion.com/v1/pages/${bk.id}`, { method: 'PATCH', headers, body: JSON.stringify({ properties: props }) })
        : await fetch('https://api.notion.com/v1/pages', { method: 'POST', headers, body: JSON.stringify({ parent: { database_id: DB_BOOKS }, properties: props }) });
      const d = await r.json();
      if (d.object === 'error') throw new Error(d.message);
      return res.status(200).json({ ok: true, book: toBook(d) });
    }

    // 📚 교재 저장 (여러 명 한 번에): items = [{ name, type, books }]
    if (action === 'set_books') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return res.status(400).json({ error: '저장할 학생이 없어요.' });
      const results = [];
      for (const it of items) {
        try {
          const q = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
            method: 'POST', headers,
            body: JSON.stringify({ filter: { and: [
              { property: '학생이름', title: { equals: it.name } },
              { property: '구분', select: { equals: it.type } }
            ]}})
          });
          const qd = await q.json();
          if (qd.object === 'error') throw new Error(qd.message);
          const page = qd.results?.[0];
          if (!page) throw new Error('등원일정에서 학생을 찾지 못했어요.');
          // 비어 있는 과목은 빼고 저장
          const clean = {};
          Object.entries(it.books || {}).forEach(([k, v]) => { if (v && (v.b || v.t)) clean[k] = v; });
          const json = Object.keys(clean).length ? JSON.stringify(clean) : '';
          const chunks = [];
          for (let i = 0; i < json.length; i += 1900) chunks.push({ text: { content: json.slice(i, i + 1900) } });
          const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
            method: 'PATCH', headers, body: JSON.stringify({ properties: { '교재': { rich_text: chunks } } })
          });
          const d = await r.json();
          if (d.object === 'error') throw new Error(d.message);
          results.push({ name: it.name, ok: true });
        } catch (e) {
          results.push({ name: it.name, ok: false, error: e.message });
        }
      }
      const failed = results.filter(r => !r.ok);
      return res.status(200).json({ ok: !failed.length, results, failed: failed.length });
    }

    // 👋 퇴원 처리: 등원일정 DB에서 휴지통으로 (노션 휴지통에서 30일간 복구 가능)
    if (action === 'archive_student') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      if (!name || !type) return res.status(400).json({ error: '학생 이름과 구분이 필요해요.' });
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', title: { equals: name } },
            { property: '구분', select: { equals: type } }
          ]}
        })
      });
      const searchData = await searchRes.json();
      if (searchData.object === 'error') throw new Error(searchData.message);
      const pages = searchData.results || [];
      if (!pages.length) return res.status(404).json({ error: '등원일정에서 학생을 찾지 못했어요.' });
      for (const p of pages) {
        const r = await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ archived: true })
        });
        const d = await r.json();
        if (d.object === 'error') throw new Error(d.message);
      }

      // 오늘 이후로 잡혀 있던 보강 예정도 정리 (지난 출결 기록은 그대로)
      const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      let removedMakeups = 0;
      try {
        const mk = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
          method: 'POST', headers,
          body: JSON.stringify({ filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '출결상태', select: { equals: '보강' } },
            { property: '날짜', date: { on_or_after: todayKST } },
          ]}})
        });
        const mkData = await mk.json();
        for (const p of (mkData.results || [])) {
          await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
            method: 'PATCH', headers, body: JSON.stringify({ archived: true })
          });
          removedMakeups++;
        }
      } catch (e) {}

      return res.status(200).json({ ok: true, count: pages.length, removedMakeups });
    }

    // 학부모 카톡 이름 저장 (등원일정 DB)
    if (action === 'set_parent_kakao') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      const parentKakao = String(body.parentKakao || '').trim();
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', title: { equals: name } },
            { property: '구분', select: { equals: type } }
          ]}
        })
      });
      const searchData = await searchRes.json();
      if (searchData.object === 'error') throw new Error(searchData.message);
      if (!searchData.results?.length) return res.status(404).json({ error: '등원일정에서 학생을 찾지 못했어요.' });
      const r = await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ properties: {
          '학부모카톡명': { rich_text: parentKakao ? [{ text: { content: parentKakao } }] : [] }
        }})
      });
      const d = await r.json();
      if (d.object === 'error') throw new Error(d.message);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '알 수 없는 action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
