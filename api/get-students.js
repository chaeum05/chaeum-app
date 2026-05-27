export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DB_STUDENTS  = process.env.NOTION_DB_STUDENTS;
  if (!NOTION_TOKEN || !DB_STUDENTS) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  try {
    // 페이지네이션으로 전체 학생 조회 (100명 이상도 처리)
    let allResults = [];
    let cursor = undefined;

    do {
      const body = {
        page_size: 100,
        sorts: [
          { property: '구분',     direction: 'ascending' },
          { property: '학년',     direction: 'ascending' },
          { property: '학생이름', direction: 'ascending' }
        ]
      };
      if (cursor) body.start_cursor = cursor;

      const queryRes = await fetch(`https://api.notion.com/v1/databases/${DB_STUDENTS}/query`, {
        method: 'POST', headers,
        body: JSON.stringify(body)
      });

      const data = await queryRes.json();
      if (data.object === 'error') throw new Error(data.message);

      allResults = allResults.concat(data.results || []);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const typeOrder = { '초등': 0, '중등': 1, '고등': 2 };

    const students = allResults
      .map(p => ({
        name:  p.properties['학생이름']?.title?.[0]?.text?.content || '',
        type:  p.properties['구분']?.select?.name || '',
        grade: p.properties['학년']?.select?.name || ''
      }))
      .filter(s => s.name)
      .sort((a, b) => {
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
