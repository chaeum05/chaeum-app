export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_SCHEDULE   = process.env.NOTION_DB_SCHEDULE;
  const DB_STUDENTS   = process.env.NOTION_DB_STUDENTS;

  if (!NOTION_TOKEN || !DB_SCHEDULE) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const queryAll = async (dbId) => {
    let all = [], cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.object === 'error') throw new Error(d.message);
      all = all.concat(d.results || []);
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);
    return all;
  };

  try {
    // 1. 등원 일정 DB → 이름/구분/학년
    const scheduleRows = await queryAll(DB_SCHEDULE);
    const typeOrder = { '초등': 0, '중등': 1, '고등': 2 };

    const students = scheduleRows
      .map(p => ({
        name:   p.properties['학생이름']?.title?.[0]?.text?.content || '',
        type:   p.properties['구분']?.select?.name || '',
        grade:  p.properties['학년']?.select?.name || '',
        school: '',
      }))
      .filter(s => s.name);

    // 2. 학생 목록 DB → 학교 정보 병합 (있을 때만)
    if (DB_STUDENTS) {
      try {
        const studentRows = await queryAll(DB_STUDENTS);
        const schoolMap = {};
        studentRows.forEach(p => {
          const name   = p.properties['학생이름']?.title?.[0]?.text?.content || '';
          const school = p.properties['학교']?.rich_text?.[0]?.text?.content || '';
          if (name && school) schoolMap[name] = school;
        });
        students.forEach(s => { if (schoolMap[s.name]) s.school = schoolMap[s.name]; });
      } catch {}
    }

    students.sort((a, b) => {
      const ta = typeOrder[a.type] ?? 3;
      const tb = typeOrder[b.type] ?? 3;
      const ga = parseInt(a.grade) || 0;
      const gb = parseInt(b.grade) || 0;
      return ta - tb || ga - gb || a.name.localeCompare(b.name, 'ko');
    });

    return res.status(200).json({ ok: true, students });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
