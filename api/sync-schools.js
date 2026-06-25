export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DB_STUDENTS  = process.env.NOTION_DB_STUDENTS;  // 학생 목록 DB
  const DB_SCHEDULE  = process.env.NOTION_DB_SCHEDULE;  // 등원 일정 DB

  if (!NOTION_TOKEN || !DB_STUDENTS || !DB_SCHEDULE) {
    return res.status(500).json({ error: '환경변수를 확인해주세요 (NOTION_TOKEN, NOTION_DB_STUDENTS, NOTION_DB_SCHEDULE)' });
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
    // 1. 학생 목록 DB → 이름:학교 맵 생성
    const studentRows = await queryAll(DB_STUDENTS);
    const schoolMap = {};
    studentRows.forEach(p => {
      const name   = p.properties['학생이름']?.title?.[0]?.text?.content?.trim() || '';
      const school = p.properties['학교']?.rich_text?.[0]?.text?.content?.trim() || '';
      if (name && school) schoolMap[name] = school;
    });

    // 2. 등원 일정 DB 전체 조회
    const scheduleRows = await queryAll(DB_SCHEDULE);

    // 3. 매칭해서 학교 업데이트
    const results = { updated: [], skipped: [], noMatch: [] };

    for (const p of scheduleRows) {
      const name = p.properties['학생이름']?.title?.[0]?.text?.content?.trim() || '';
      const existingSchool = p.properties['학교']?.rich_text?.[0]?.text?.content?.trim() || '';
      const school = schoolMap[name];

      if (!name) continue;
      if (!school) { results.noMatch.push(name); continue; }
      if (existingSchool === school) { results.skipped.push(name); continue; }

      // 학교 정보 업데이트
      const r = await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({
          properties: { '학교': { rich_text: [{ text: { content: school } }] } }
        })
      });
      const d = await r.json();
      if (d.object === 'error') {
        results.noMatch.push(`${name} (오류: ${d.message})`);
      } else {
        results.updated.push(`${name} → ${school}`);
      }
    }

    return res.status(200).json({
      ok: true,
      summary: {
        학교맵_학생수: Object.keys(schoolMap).length,
        등원일정_총학생수: scheduleRows.length,
        업데이트됨: results.updated.length,
        이미동일: results.skipped.length,
        매칭안됨: results.noMatch.length,
      },
      updated: results.updated,
      noMatch: results.noMatch,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
