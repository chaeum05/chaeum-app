export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN    = process.env.NOTION_TOKEN;
  const DB_EXAM         = process.env.NOTION_DB_EXAM;
  const DB_STUDENT_EXAM = process.env.NOTION_DB_STUDENT_EXAM;

  if (!NOTION_TOKEN || !DB_EXAM || !DB_STUDENT_EXAM) {
    return res.status(500).json({ error: '환경변수를 확인해주세요. (NOTION_DB_EXAM, NOTION_DB_STUDENT_EXAM)' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const { action } = req.body;

  try {

    // ── 학교 시험정보 전체 조회 ──
    if (action === 'get_exams') {
      let allResults = [], cursor;
      do {
        const body = { page_size: 100, sorts: [{ property: '학교명', direction: 'ascending' }] };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_EXAM}/query`, {
          method: 'POST', headers, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.object === 'error') throw new Error(d.message);
        allResults = allResults.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      const exams = allResults.map(p => ({
        id:            p.id,
        school:        p.properties['학교명']?.title?.[0]?.text?.content || '',
        grade:         p.properties['학년']?.select?.name || '',
        examType:      p.properties['시험종류']?.select?.name || '',
        periodStart:   p.properties['시험기간_시작']?.date?.start || '',
        periodEnd:     p.properties['시험기간_종료']?.date?.start || '',
        examDate:      p.properties['시험일']?.date?.start || '',
        attendDay:     p.properties['등원일']?.rich_text?.[0]?.text?.content || '',
        textbookRange: p.properties['교과서_범위']?.rich_text?.[0]?.text?.content || '',
        subTextRange:  p.properties['부교재_범위']?.rich_text?.[0]?.text?.content || '',
        mockRange:     p.properties['모의고사_범위']?.rich_text?.[0]?.text?.content || '',
        extraRange:    p.properties['기타범위']?.rich_text?.[0]?.text?.content || '',
        memo:          p.properties['메모']?.rich_text?.[0]?.text?.content || '',
      }));
      return res.status(200).json({ ok: true, exams });
    }

    // ── 학교 시험정보 저장/수정 ──
    if (action === 'save_exam') {
      const { id, school, grade, examType, periodStart, periodEnd, examDate,
              attendDay, textbookRange, subTextRange, mockRange, memo } = req.body;
      const props = {
        '학교명':      { title:     [{ text: { content: school || '' } }] },
        '학년':        { select:    grade    ? { name: grade }    : null },
        '시험종류':    { select:    examType ? { name: examType } : null },
        '등원일':      { rich_text: [{ text: { content: attendDay     || '' } }] },
        '교과서_범위': { rich_text: [{ text: { content: textbookRange || '' } }] },
        '부교재_범위': { rich_text: [{ text: { content: subTextRange  || '' } }] },
        '모의고사_범위':{ rich_text: [{ text: { content: mockRange     || '' } }] },
        '기타범위':    { rich_text: [{ text: { content: req.body.extraRange || '' } }] },
        '메모':        { rich_text: [{ text: { content: memo          || '' } }] },
        '시험기간_시작': periodStart ? { date: { start: periodStart } } : { date: null },
        '시험기간_종료': periodEnd   ? { date: { start: periodEnd   } } : { date: null },
        '시험일':        examDate    ? { date: { start: examDate    } } : { date: null },
      };
      // null 제거
      Object.keys(props).forEach(k => { if (props[k]?.select === null) delete props[k]; if (props[k]?.date === null) delete props[k]; });

      if (id) {
        await fetch(`https://api.notion.com/v1/pages/${id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ properties: props })
        });
        return res.status(200).json({ ok: true, message: '시험정보 수정 완료' });
      } else {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({ parent: { database_id: DB_EXAM }, properties: props })
        });
        return res.status(200).json({ ok: true, message: '시험정보 등록 완료' });
      }
    }

    // ── 학교 시험정보 삭제 ──
    if (action === 'delete_exam') {
      const { id } = req.body;
      await fetch(`https://api.notion.com/v1/pages/${id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ archived: true })
      });
      return res.status(200).json({ ok: true, message: '삭제 완료' });
    }

    // ── 학생 시험관리 전체 조회 ──
    if (action === 'get_student_exams') {
      const { examType } = req.body;
      const filter = examType
        ? { property: '시험종류', select: { equals: examType } }
        : undefined;
      let allResults = [], cursor;
      do {
        const body = { page_size: 100 };
        if (filter) body.filter = filter;
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_STUDENT_EXAM}/query`, {
          method: 'POST', headers, body: JSON.stringify(body)
        });
        const d = await r.json();
        allResults = allResults.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      const students = allResults.map(p => ({
        id:           p.id,
        name:         p.properties['학생이름']?.title?.[0]?.text?.content || '',
        type:         p.properties['구분']?.select?.name || '',
        grade:        p.properties['학년']?.select?.name || '',
        school:       p.properties['학교명']?.rich_text?.[0]?.text?.content || '',
        examType:     p.properties['시험종류']?.select?.name || '',
        makeupDate:   p.properties['직전보강_날짜']?.date?.start || '',
        makeupTime:   p.properties['직전보강_시간']?.rich_text?.[0]?.text?.content || '',
        special:      p.properties['특별관리']?.checkbox || false,
        subText:      p.properties['부교재']?.number || 0,
        final:        p.properties['Final']?.checkbox || false,
        extra:        p.properties['추가문제']?.checkbox || false,
        memo:         p.properties['메모']?.rich_text?.[0]?.text?.content || '',
      }));
      return res.status(200).json({ ok: true, students });
    }

    // ── 학생 시험관리 저장/수정 ──
    if (action === 'save_student_exam') {
      const { id, name, type, grade, school, examType,
              makeupDate, makeupTime, special, subText, final, extra, memo } = req.body;
      const props = {
        '학생이름':  { title:     [{ text: { content: name || '' } }] },
        '학교명':    { rich_text: [{ text: { content: school || '' } }] },
        '직전보강_시간': { rich_text: [{ text: { content: makeupTime || '' } }] },
        '메모':      { rich_text: [{ text: { content: memo || '' } }] },
        '특별관리':  { checkbox: !!special },
        'Final':     { checkbox: !!final },
        '추가문제':  { checkbox: !!extra },
        '부교재':    { number: Number(subText) || 0 },
        ...(type     ? { '구분':     { select: { name: type } } }     : {}),
        ...(grade    ? { '학년':     { select: { name: grade } } }    : {}),
        ...(examType ? { '시험종류': { select: { name: examType } } } : {}),
        '직전보강_날짜': makeupDate ? { date: { start: makeupDate } } : { date: null },
      };
      if (props['직전보강_날짜']?.date === null) delete props['직전보강_날짜'];

      if (id) {
        await fetch(`https://api.notion.com/v1/pages/${id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ properties: props })
        });
      } else {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({ parent: { database_id: DB_STUDENT_EXAM }, properties: props })
        });
      }
      return res.status(200).json({ ok: true, message: '학생 시험관리 저장 완료' });
    }

    return res.status(400).json({ error: '알 수 없는 action' });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
