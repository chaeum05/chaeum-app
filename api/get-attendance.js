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

    // 2. 오늘 날짜 출결 기록 조회
    const attendRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: { property: '날짜', date: { equals: today } }
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

    // 오늘 출결 기록에 있는 학생 중 정규 등원 목록에 없는 학생 추가 (보강 수동 등록 포함)
    const studentNames = new Set(students.map(s => s.name));
    attendance.forEach(a => {
      if (a.name && !studentNames.has(a.name)) {
        // 정규 목록에 없는 학생 → 보강으로 온 학생
        students.push({ id: '', name: a.name, type: a.type, grade: a.grade, isMakeup: true });
        studentNames.add(a.name);
      }
    });

    // 3. 보강 대기 목록 (결석 미보강 + 보강 예정 모두)
    const makeupRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: {
          or: [
            { property: '출결상태', select: { equals: '결석' } },
            { property: '출결상태', select: { equals: '보강' } }
          ]
        },
        sorts: [{ property: '날짜', direction: 'ascending' }]
      })
    });
    const makeupData = await makeupRes.json();

    const makeupList = (makeupData.results || []).map(p => ({
      id:          p.id,
      name:        p.properties['학생이름']?.rich_text?.[0]?.text?.content || '',
      type:        p.properties['구분']?.select?.name || '',
      grade:       p.properties['학년']?.select?.name || '',
      absentDate:  p.properties['원래날짜']?.date?.start || p.properties['날짜']?.date?.start || '',
      memo:        p.properties['메모']?.rich_text?.[0]?.text?.content || '',
    }));

    return res.status(200).json({ students, attendance, makeupList, date: today, dayName });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
