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
        semester:      p.properties['학기']?.select?.name || '',
        examType:      p.properties['시험종류']?.select?.name || '',
        periodStart:   p.properties['시험기간_시작']?.date?.start || '',
        periodEnd:     p.properties['시험기간_종료']?.date?.start || '',
        examDate:      p.properties['시험일']?.date?.start || '',
        attendDay:     p.properties['등원일']?.rich_text?.[0]?.text?.content || '',
        textbookRange: p.properties['교과서_범위']?.rich_text?.[0]?.text?.content || '',
        subTextRange:  p.properties['부교재_범위']?.rich_text?.[0]?.text?.content || '',
        mockRange:     p.properties['모의고사_범위']?.rich_text?.[0]?.text?.content || '',
        extraRange:    p.properties['기타범위']?.rich_text?.[0]?.text?.content || '',
        rangeConfirmed:    p.properties['범위확정']?.checkbox || false,
        finalReady:        p.properties['파이널준비']?.checkbox || false,
        comprehensiveReady:p.properties['종합문제']?.checkbox || false,
        memo:          p.properties['메모']?.rich_text?.[0]?.text?.content || '',
      }));
      return res.status(200).json({ ok: true, exams });
    }

    // ── 학교 시험정보 저장/수정 ──
    if (action === 'save_exam') {
      const { id, school, grade, semester, examType, periodStart, periodEnd, examDate,
              attendDay, textbookRange, subTextRange, mockRange, memo } = req.body;
      const props = {
        '학교명':      { title:     [{ text: { content: school || '' } }] },
        '학년':        { select:    grade    ? { name: grade }    : null },
        '학기':        { select:    semester ? { name: semester } : null },
        '시험종류':    { select:    examType ? { name: examType } : null },
        '등원일':      { rich_text: [{ text: { content: attendDay     || '' } }] },
        '교과서_범위': { rich_text: [{ text: { content: textbookRange || '' } }] },
        '부교재_범위': { rich_text: [{ text: { content: subTextRange  || '' } }] },
        '모의고사_범위':{ rich_text: [{ text: { content: mockRange     || '' } }] },
        '기타범위':    { rich_text: [{ text: { content: req.body.extraRange || '' } }] },
        '범위확정':    { checkbox: !!req.body.rangeConfirmed },
        '파이널준비':  { checkbox: !!req.body.finalReady },
        '종합문제':    { checkbox: !!req.body.comprehensiveReady },
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

    // ═══════════ 🗓️ 학원 일정 (일정 메뉴) ═══════════
    // 선생님들이 직접 추가·수정하는 일정 + 시험 DB의 학교 시험 + 출결 DB의 보강을 한 달력에 모아서 보여줌
    if (action === 'cal_list' || action === 'cal_save' || action === 'cal_delete') {
      const DB_CAL = process.env.NOTION_DB_CALENDAR || '423f94e116a28113a1e9e7a17c681560';
      const txt = p => (p?.rich_text || p?.title || []).map(t => t.plain_text ?? t.text?.content ?? '').join('');
      const queryAll = async (db, body) => {
        let out = [], cursor;
        do {
          const r = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
            method: 'POST', headers, body: JSON.stringify({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
          });
          const d = await r.json();
          if (d.object === 'error') throw new Error(d.message);
          out = out.concat(d.results || []);
          cursor = d.has_more ? d.next_cursor : undefined;
        } while (cursor);
        return out;
      };

      if (action === 'cal_list') {
        const { from, to } = req.body;   // YYYY-MM-DD (달력에 보이는 범위)
        if (!from || !to) return res.status(400).json({ error: '기간(from, to)이 필요해요' });
        const events = [];

        // 1) 직접 등록한 일정 — 기간이 걸쳐 있는 것도 보이도록 시작일은 넉넉하게(60일 전부터) 가져와서 걸러냄
        const fromWide = new Date(new Date(from + 'T00:00:00Z').getTime() - 60 * 86400000).toISOString().slice(0, 10);
        const own = await queryAll(DB_CAL, { filter: { and: [
          { property: '날짜', date: { on_or_after: fromWide } },
          { property: '날짜', date: { on_or_before: to } },
        ]}, sorts: [{ property: '날짜', direction: 'ascending' }] });
        own.forEach(p => {
          const pr = p.properties;
          const start = pr['날짜']?.date?.start?.slice(0, 10) || '';
          const end = pr['날짜']?.date?.end?.slice(0, 10) || start;
          if (!start || end < from) return;
          events.push({
            id: p.id, src: 'own', title: txt(pr['제목']), start, end,
            category: pr['분류']?.select?.name || '기타',
            time: txt(pr['시간']), target: txt(pr['대상']),
            owner: pr['담당']?.select?.name || '', status: pr['상태']?.select?.name || '예정',
            memo: txt(pr['메모']), author: txt(pr['작성자']), editor: txt(pr['수정자']),
            edited: p.last_edited_time,
          });
        });

        // 2) 학교 시험 (시험 관리 메뉴의 시험정보) — 읽기 전용
        //    시험기간(period) · 영어 시험일(examday) · 직전보강(premakeup = 시험일 전날, 시험 관리 달력과 같은 규칙)
        try {
          const exams = await queryAll(DB_EXAM, {});
          const fromP = new Date(new Date(from + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
          exams.forEach(p => {
            const pr = p.properties;
            const school = txt(pr['학교명']).replace(/(고등학교|중학교)/g, '').trim();
            const grade = (pr['학년']?.select?.name || '').replace('학년', '');
            const kind = pr['시험종류']?.select?.name || '시험';
            const label = `${school}${grade}`;
            const ps = pr['시험기간_시작']?.date?.start?.slice(0, 10) || '';
            const pe = pr['시험기간_종료']?.date?.start?.slice(0, 10) || ps;
            const ed = pr['시험일']?.date?.start?.slice(0, 10) || '';
            if (ps && pe >= from && ps <= to)
              events.push({ id: 'exp-' + p.id, src: 'exam', kind: 'period', title: `${label} ${kind}`, school, grade,
                start: ps, end: pe, category: '학교시험', memo: txt(pr['메모']) });
            if (ed && ed >= from && ed <= to)
              events.push({ id: 'exd-' + p.id, src: 'exam', kind: 'examday', title: `${label} 영어`, school, grade,
                start: ed, end: ed, category: '학교시험' });
            if (ed && ed >= fromP && ed <= to) {
              const d = new Date(ed + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
              const pd = d.toISOString().slice(0, 10);
              if (pd >= from && pd <= to)
                events.push({ id: 'exm-' + p.id, src: 'exam', kind: 'premakeup', title: label, school, grade,
                  start: pd, end: pd, category: '보강·수업' });
            }
          });
        } catch (e) { /* 시험 DB를 못 읽어도 달력은 보여줌 */ }

        // 3) 보강 (출결 관리에서 잡은 보강) — 읽기 전용, 하루에 한 묶음으로
        const DB_ATT = process.env.NOTION_DB_ATTENDANCE;
        if (DB_ATT) {
          try {
            const mk = await queryAll(DB_ATT, { filter: { and: [
              { or: ['보강', '보강완료', '시험기간보강'].map(v => ({ property: '출결상태', select: { equals: v } })) },
              { property: '날짜', date: { on_or_after: from } },
              { property: '날짜', date: { on_or_before: to } },
            ]}});
            const byDay = {};
            mk.forEach(p => {
              const d = p.properties['날짜']?.date?.start?.slice(0, 10);
              const n = txt(p.properties['학생이름']);
              if (!d || !n) return;
              (byDay[d] = byDay[d] || new Set()).add(n);
            });
            Object.entries(byDay).forEach(([d, names]) => {
              const list = [...names];
              events.push({ id: 'mk-' + d, src: 'makeup', title: `보강 ${list.length}명`, start: d, end: d,
                category: '보강·수업', target: list.join(', ') });
            });
          } catch (e) { /* 무시 */ }
        }
        return res.status(200).json({ ok: true, events });
      }

      if (action === 'cal_save') {
        const { id, title, start, end, category, time, target, owner, status, memo, who } = req.body;
        if (!title || !start) return res.status(400).json({ error: '제목과 날짜는 꼭 넣어주세요' });
        const rt = v => ({ rich_text: [{ text: { content: String(v || '').slice(0, 1900) } }] });
        const props = {
          '제목': { title: [{ text: { content: String(title).slice(0, 200) } }] },
          '날짜': { date: { start, end: end && end > start ? end : null } },
          '분류': { select: { name: category || '기타' } },
          '시간': rt(time), '대상': rt(target), '메모': rt(memo),
          '상태': { select: { name: status || '예정' } },
          '담당': owner ? { select: { name: owner } } : { select: null },
        };
        if (id) {
          props['수정자'] = rt(who);
          const r = await fetch(`https://api.notion.com/v1/pages/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ properties: props }) });
          const d = await r.json(); if (d.object === 'error') throw new Error(d.message);
          return res.status(200).json({ ok: true, id, message: '일정을 고쳤어요' });
        }
        props['작성자'] = rt(who);
        const r = await fetch('https://api.notion.com/v1/pages', { method: 'POST', headers,
          body: JSON.stringify({ parent: { database_id: DB_CAL }, properties: props }) });
        const d = await r.json(); if (d.object === 'error') throw new Error(d.message);
        return res.status(200).json({ ok: true, id: d.id, message: '일정을 추가했어요' });
      }

      if (action === 'cal_delete') {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'id가 필요해요' });
        const r = await fetch(`https://api.notion.com/v1/pages/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ archived: true }) });
        const d = await r.json(); if (d.object === 'error') throw new Error(d.message);
        return res.status(200).json({ ok: true, message: '일정을 지웠어요 (노션 휴지통에서 되살릴 수 있어요)' });
      }
    }

    return res.status(400).json({ error: '알 수 없는 action' });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
