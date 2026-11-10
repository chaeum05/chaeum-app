export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN    = process.env.NOTION_TOKEN;
  const DB_SCHEDULE     = process.env.NOTION_DB_SCHEDULE;
  const DB_ATTENDANCE   = process.env.NOTION_DB_ATTENDANCE;

  if (!NOTION_TOKEN || !DB_SCHEDULE || !DB_ATTENDANCE) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { date } = body;
  const today = date || new Date().toISOString().split('T')[0];

  // 요일 계산 (0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토)
  const dayMap = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금' };
  const dayOfWeek = new Date(today + 'T00:00:00').getDay();
  const dayName = dayMap[dayOfWeek];

  // 주말: 정규 수업은 없지만 주말 보강·출석 체크 기록은 보여줌
  if (!dayName) {
    try {
      const r = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '날짜', date: { on_or_after:  today } },
            { property: '날짜', date: { on_or_before: today } },
          ]},
          sorts: [{ property: '학생이름', direction: 'ascending' }]
        })
      });
      const d = await r.json();
      const attendance = (d.results || []).map(p => ({
        id:     p.id,
        name:   p.properties['학생이름']?.rich_text?.[0]?.text?.content || '',
        status: p.properties['출결상태']?.select?.name || '',
        memo:   p.properties['메모']?.rich_text?.[0]?.text?.content || '',
        type:   p.properties['구분']?.select?.name || '',
        grade:  p.properties['학년']?.select?.name || '',
        inTime:  (p.properties['등원시각']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
        outTime: (p.properties['하원시각']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
        inAlim:  (p.properties['등원알림']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
        outAlim: (p.properties['하원알림']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
      })).filter(a => a.name);
      const seen = new Set();
      const students = [];
      attendance.forEach(a => {
        const k = `${a.name}_${a.type}_${a.grade}`;
        if (seen.has(k)) return; seen.add(k);
        students.push({ id: '', name: a.name, type: a.type, grade: a.grade, isMakeup: true });
      });
      return res.status(200).json({ students, attendance, makeupList: [], sessionStudents: [], date: today, dayName: '주말' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    // 1. 오늘 요일에 등원하는 학생 목록 조회
    const scheduleRes = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: { property: dayName, checkbox: { equals: true } },
        sorts: [
          { property: '구분', direction: 'ascending' },
          { property: '학년', direction: 'ascending' },
          { property: '학생이름', direction: 'ascending' }
        ]
      })
    });
    const scheduleData = await scheduleRes.json();

    const students = (scheduleData.results || []).map(p => {
      // 그날 요일의 담임 (담임_월 등), 없으면 기본 담임 폴백
      const dayTeacher = p.properties[`담임_${dayName}`]?.select?.name || '';
      const baseTeacher = p.properties['담임']?.select?.name || '';
      return {
        id:     p.id,
        name:   p.properties['학생이름']?.title?.[0]?.text?.content || '',
        type:   p.properties['구분']?.select?.name || '',
        grade:  p.properties['학년']?.select?.name || '',
        school: p.properties['학교']?.rich_text?.[0]?.text?.content?.trim() || '',
        teacher: dayTeacher || baseTeacher,
        // 그날 요일의 수업부 (수업부_월 등), 없으면 기본 수업부
        period: p.properties[`수업부_${dayName}`]?.select?.name || p.properties['수업부']?.select?.name || '',
        startDate: p.properties['등록일']?.date?.start?.slice(0, 10) || '',
        lessonType: p.properties['수업형태']?.select?.name === '회차' ? '회차' : '',
        isMakeup: false,
      };
    }).filter(s => s.name && (!s.startDate || s.startDate <= today) && s.lessonType !== '회차'); // 등록일 이전 날짜엔 안 나옴 · 회차 학생은 아래 따로

    // 1-1. 재원생 명단 (등원일정 전체) — 퇴원 처리된 학생은 여기 없음
    const activeNames = new Set();
    const regDays = {};                  // 이름 → 정규 수업 요일
    const sessionStudents = [];   // 🎫 회차 수업 학생 (그날 수업 요일인 학생만 따로 보여줌)
    const allSessionNames = new Set();   // 회차 학생 전체 (보강 대기·보강 줄에서 빼는 용도)
    const sessionAll = {};               // 회차 학생 정보 (수업 요일이 아닌 날 와도 보여주려고)
    let cursor;
    do {
      const q = { page_size: 100 };
      if (cursor) q.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
        method: 'POST', headers, body: JSON.stringify(q)
      });
      const d = await r.json();
      if (d.object === 'error') throw new Error(d.message);
      (d.results || []).forEach(p => {
        const n = p.properties['학생이름']?.title?.[0]?.text?.content?.trim();
        if (n) activeNames.add(n);
        if (n) regDays[n] = ['월','화','수','목','금'].filter(k => p.properties[k]?.checkbox);
        const sd = p.properties['등록일']?.date?.start?.slice(0, 10) || '';
        // 회차 학생: 수업 요일(예: 금)이 정해져 있으면 그날만, 요일이 없으면 매일 보여줌
        if (n && p.properties['수업형태']?.select?.name === '회차') {
          allSessionNames.add(n);
          sessionAll[n] = { id: p.id, name: n, type: p.properties['구분']?.select?.name || '', grade: p.properties['학년']?.select?.name || '',
            school: p.properties['학교']?.rich_text?.[0]?.text?.content?.trim() || '', teacher: p.properties['담임']?.select?.name || '', lessonType: '회차', isMakeup: false };
        }
        const anyDay = ['월','화','수','목','금'].some(k => p.properties[k]?.checkbox);
        const onToday = !anyDay || !!p.properties[dayName]?.checkbox;
        if (n && p.properties['수업형태']?.select?.name === '회차' && onToday && (!sd || sd <= today)) sessionStudents.push({
          id: p.id, name: n,
          type: p.properties['구분']?.select?.name || '',
          grade: p.properties['학년']?.select?.name || '',
          school: p.properties['학교']?.rich_text?.[0]?.text?.content?.trim() || '',
          teacher: p.properties['담임']?.select?.name || '',
          lessonType: '회차', isMakeup: false,
        });
      });
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);
    const isActive = n => activeNames.has(String(n || '').trim());
    const sessionNames = allSessionNames;

    // 2. 오늘 날짜 출결 기록 조회 (timezone 안전하게 on_or_after + on_or_before)
    const attendRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: {
          and: [
            { property: '날짜', date: { on_or_after:  today } },
            { property: '날짜', date: { on_or_before: today } },
          ]
        },
        sorts: [{ property: '학생이름', direction: 'ascending' }]
      })
    });
    const attendData = await attendRes.json();

    const attendance = (attendData.results || []).map(p => ({
      id:     p.id,
      name:   p.properties['학생이름']?.rich_text?.[0]?.text?.content || '',
      status: p.properties['출결상태']?.select?.name || '',
      memo:   p.properties['메모']?.rich_text?.[0]?.text?.content || '',
      type:   p.properties['구분']?.select?.name || '',
      grade:  p.properties['학년']?.select?.name || '',
      inTime:  (p.properties['등원시각']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
      outTime: (p.properties['하원시각']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
      inAlim:  (p.properties['등원알림']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
      outAlim: (p.properties['하원알림']?.rich_text || []).map(t => t.plain_text || '').join('').trim(),
    }));

    // 회차 학생: 수업 요일이 아니어도 오늘 기록이 있으면(출석 체크 등) 회차 줄에 보여줌
    const sessKeys = new Set(sessionStudents.map(x => x.name));
    attendance.forEach(a => {
      if (a.name && sessionAll[a.name] && !sessKeys.has(a.name)) { sessionStudents.push(sessionAll[a.name]); sessKeys.add(a.name); }
    });

    // 오늘 출결 기록에 있는 학생 중 정규 목록에 없는 학생 추가 (보강 등)
    const studentKeys = new Set(students.map(s => `${s.name}_${s.type}_${s.grade}`));
    attendance.forEach(a => {
      const key = `${a.name}_${a.type}_${a.grade}`;
      if (a.name && !studentKeys.has(key) && isActive(a.name) && !sessionNames.has(a.name)) { // 퇴원생 보강 기록·회차 학생은 제외
        students.push({ id: '', name: a.name, type: a.type, grade: a.grade, isMakeup: true });
        studentKeys.add(key);
      }
    });

    // 3. 결석 조회 — 보강 대기는 이번 달 1일부터 (매달 새로 시작)
    const MAKEUP_WINDOW_DAYS = 42;
    const limitDate = today.slice(0, 7) + '-01';   // 보강 대기는 매달 1일부터 (지난달 결석은 보강 의무 없음)

    const makeupRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: {
          and: [
            { property: '출결상태', select: { equals: '결석' } },
            { property: '날짜', date: { on_or_after: limitDate } },
          ]
        },
        sorts:  [{ property: '날짜', direction: 'ascending' }],
        page_size: 100
      })
    });
    const makeupData = await makeupRes.json();
    // 결석이 100개 넘으면 나머지도 불러오기
    let mkCursor = makeupData.has_more ? makeupData.next_cursor : undefined;
    while (mkCursor) {
      const rr = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, { method: 'POST', headers, body: JSON.stringify({
        filter: { and: [
          { property: '출결상태', select: { equals: '결석' } },
          { property: '날짜', date: { on_or_after: limitDate } },
        ]}, sorts: [{ property: '날짜', direction: 'ascending' }], page_size: 100, start_cursor: mkCursor,
      })});
      const dd = await rr.json();
      if (dd.object === 'error') break;
      makeupData.results = (makeupData.results || []).concat(dd.results || []);
      mkCursor = dd.has_more ? dd.next_cursor : undefined;
    }

    // 4. 보강/보강완료 기록 전체 조회
    const scheduledRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: {
          and: [
            { or: ['보강', '보강완료', '시험기간보강'].map(v => ({ property: '출결상태', select: { equals: v } })) },
            { property: '날짜', date: { on_or_after: new Date(new Date(limitDate).getTime() - 8 * 24 * 3600 * 1000).toISOString().slice(0, 10) } },
          ]
        },
        page_size: 100
      })
    });
    const scheduledData = await scheduledRes.json();
    // 기록이 100개 넘으면 나머지도 불러오기
    let schCursor = scheduledData.has_more ? scheduledData.next_cursor : undefined;
    while (schCursor) {
      const body0 = JSON.parse(JSON.stringify({ filter: { and: [
        { or: ['보강', '보강완료', '시험기간보강'].map(v => ({ property: '출결상태', select: { equals: v } })) },
        { property: '날짜', date: { on_or_after: new Date(new Date(limitDate).getTime() - 8 * 24 * 3600 * 1000).toISOString().slice(0, 10) } },
      ]}, page_size: 100, start_cursor: schCursor }));
      const rr = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, { method: 'POST', headers, body: JSON.stringify(body0) });
      const dd = await rr.json();
      if (dd.object === 'error') break;
      scheduledData.results = (scheduledData.results || []).concat(dd.results || []);
      schCursor = dd.has_more ? dd.next_cursor : undefined;
    }

    // 결석한 학생이 정규 요일이 아닌 날 '출석'으로 찍힌 것도 보강으로 셈 (선생님이 출석으로 눌렀을 때)
    const absNames = [...new Set((makeupData.results || []).map(p => p.properties['학생이름']?.rich_text?.[0]?.text?.content || '').filter(Boolean))];
    for (let i = 0; i < absNames.length; i += 40) {
      const chunk = absNames.slice(i, i + 40);
      const rr = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, { method: 'POST', headers, body: JSON.stringify({
        filter: { and: [
          { property: '출결상태', select: { equals: '출석' } },
          { property: '날짜', date: { on_or_after: limitDate } },
          { or: chunk.map(n => ({ property: '학생이름', rich_text: { equals: n } })) },
        ]}, page_size: 100,
      })});
      const dd = await rr.json();
      if (dd.object !== 'error') scheduledData.results = (scheduledData.results || []).concat(dd.results || []);
    }

    // 보강 기록 인덱싱
    //  - 보강·보강완료: 그대로 보강으로 봄
    //  - 시험기간보강·출석: 정규 수업 요일이 아닌 날 온 것만 보강으로 봄 (정규일에 온 건 원래 수업)
    const W = ['일','월','화','수','목','금','토'];
    const scheduledByName = {};
    (scheduledData.results || []).forEach(p => {
      const n      = p.properties['학생이름']?.rich_text?.[0]?.text?.content || '';
      const ad     = p.properties['원래날짜']?.date?.start || '';
      const md     = (p.properties['날짜']?.date?.start || '').slice(0, 10);
      const status = p.properties['출결상태']?.select?.name || '';
      if (!n || !md) return;
      if (status === '시험기간보강' || status === '출석') {
        const dow = W[new Date(md + 'T00:00:00').getDay()];
        if ((regDays[n] || []).includes(dow) && !ad) return;   // 정규일 수업은 보강 아님
      }
      (scheduledByName[n] = scheduledByName[n] || []).push({ absentDate: ad ? ad.slice(0, 10) : '', makeupDate: md, status, used: false });
    });

    // 결석 한 번에 보강 한 번씩 짝짓기 (원래날짜가 적힌 것 먼저, 나머지는 결석 순서대로)
    const absByName = {};
    (makeupData.results || []).forEach(p => {
      const n = p.properties['학생이름']?.rich_text?.[0]?.text?.content || '';
      const d = (p.properties['날짜']?.date?.start || '').slice(0, 10);
      if (n && d) (absByName[n] = absByName[n] || []).push(d);
    });
    const covered = new Set();   // "이름|결석일"
    Object.entries(absByName).forEach(([n, dates]) => {
      const recs = scheduledByName[n] || [];
      dates.sort();
      // 1순위: 원래날짜가 정확히 일치
      dates.forEach(d => {
        const r = recs.find(x => !x.used && x.absentDate === d);
        if (r) { r.used = true; covered.add(n + '|' + d); }
      });
      // 2순위: 원래날짜 없는 보강·비정규일 등원 → 결석일 7일 전 ~ 30일 뒤 안에서 가까운 것부터
      dates.forEach(d => {
        if (covered.has(n + '|' + d)) return;
        const at = new Date(d + 'T00:00:00').getTime();
        const cand = recs.filter(x => !x.used && !x.absentDate && x.makeupDate !== d)
          .map(x => ({ x, diff: (new Date(x.makeupDate + 'T00:00:00').getTime() - at) / 86400000 }))
          .filter(o => o.diff >= -7 && o.diff <= MAKEUP_WINDOW_DAYS)
          .sort((p1, p2) => (p1.diff < 0) - (p2.diff < 0) || Math.abs(p1.diff) - Math.abs(p2.diff));
        if (cand.length) { cand[0].x.used = true; covered.add(n + '|' + d); }
      });
    });
    const hasMakeup = (name, absentDate) => covered.has(name + '|' + String(absentDate).slice(0, 10));

    // 보강이 안 잡힌 결석만 보강 대기로
    const makeupList = (makeupData.results || [])
      .map(p => ({
        id:         p.id,
        name:       p.properties['학생이름']?.rich_text?.[0]?.text?.content || '',
        type:       p.properties['구분']?.select?.name || '',
        grade:      p.properties['학년']?.select?.name || '',
        absentDate: p.properties['날짜']?.date?.start || '',
        memo:       p.properties['메모']?.rich_text?.[0]?.text?.content || '',
      }))
      .filter(m => m.name && isActive(m.name) && !sessionNames.has(m.name) && !hasMakeup(m.name, m.absentDate)) // 퇴원생·회차 학생 제외
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

    return res.status(200).json({ students, attendance, makeupList, sessionStudents, date: today, dayName });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
