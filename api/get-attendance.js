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

  const { date } = req.body || {};
  const today = date || new Date().toISOString().split('T')[0];

  // 요일 계산 (0=일, 1=월, 2=화, 3=수, 4=목, 5=금, 6=토)
  const dayMap = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금' };
  const dayOfWeek = new Date(today + 'T00:00:00').getDay();
  const dayName = dayMap[dayOfWeek];

  if (!dayName) {
    return res.status(200).json({ students: [], attendance: [], date: today, dayName: '주말' });
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

    const students = (scheduleData.results || []).map(p => ({
      id: p.id,
      name:  p.properties['학생이름']?.title?.[0]?.text?.content || '',
      type:  p.properties['구분']?.select?.name || '',
      grade: p.properties['학년']?.select?.name || '',
      isMakeup: false,  // 정규 수업
    })).filter(s => s.name);

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
    }));

    // 오늘 출결 기록에 있는 학생 중 정규 목록에 없는 학생 추가 (보강 등)
    const studentKeys = new Set(students.map(s => `${s.name}_${s.type}_${s.grade}`));
    attendance.forEach(a => {
      const key = `${a.name}_${a.type}_${a.grade}`;
      if (a.name && !studentKeys.has(key)) {
        students.push({ id: '', name: a.name, type: a.type, grade: a.grade, isMakeup: true });
        studentKeys.add(key);
      }
    });

    // 3. 결석 전체 조회
    const makeupRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: { property: '출결상태', select: { equals: '결석' } },
        sorts:  [{ property: '날짜', direction: 'ascending' }],
        page_size: 100
      })
    });
    const makeupData = await makeupRes.json();

    // 4. 보강 기록 전체 조회 (출결상태 = 보강 OR 보강완료)
    const scheduledRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: {
          or: [
            { property: '출결상태', select: { equals: '보강' } },
            { property: '출결상태', select: { equals: '보강완료' } },
          ]
        },
        page_size: 100
      })
    });
    const scheduledData = await scheduledRes.json();

    // 보강 기록: 학생 이름 기준 Set 만들기 (absentDate 있으면 정확 매칭, 없으면 이름만)
    const scheduledByName = {}; // { name: [{ absentDate, makeupDate }] }
    (scheduledData.results || []).forEach(p => {
      const n  = p.properties['학생이름']?.rich_text?.[0]?.text?.content || '';
      const ad = p.properties['원래날짜']?.date?.start || '';
      const md = p.properties['날짜']?.date?.start || '';
      if (!n) return;
      if (!scheduledByName[n]) scheduledByName[n] = [];
      scheduledByName[n].push({ absentDate: ad, makeupDate: md });
    });

    // 결석 건에 보강이 잡혔는지 확인
    const hasMakeup = (name, absentDate) => {
      const records = scheduledByName[name];
      if (!records || records.length === 0) return false;
      return records.some(r => {
        // 1순위: 원래날짜(결석일)가 정확히 일치 → 가장 확실한 매칭
        if (r.absentDate && r.absentDate === absentDate) return true;
        // 2순위: 원래날짜 없는 보강 → 보강날짜가 결석일 이후 14일 이내
        // (보강날짜 < 결석일이면 사전보강이므로 제외 - 다른 결석의 보강일 수 있음)
        if (!r.absentDate && r.makeupDate) {
          const makeupTime  = new Date(r.makeupDate).getTime();
          const absentTime  = new Date(absentDate).getTime();
          const diffDays    = (makeupTime - absentTime) / (1000 * 60 * 60 * 24);
          // 결석일 이후 ~ 14일 이내만 해당 결석의 보강으로 인정
          return diffDays >= 0 && diffDays <= 14;
        }
        return false;
      });
    };

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
      .filter(m => m.name && !hasMakeup(m.name, m.absentDate));

    return res.status(200).json({ students, attendance, makeupList, date: today, dayName });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
