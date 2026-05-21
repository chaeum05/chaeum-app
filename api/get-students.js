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

  try {
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${DB_STUDENTS}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        sorts: [
          { property: '구분',     direction: 'ascending' },
          { property: '학생이름', direction: 'ascending' }
        ]
      })
    });

    const data = await queryRes.json();
    if (data.object === 'error') throw new Error(data.message);

    const students = data.results.map(p => ({
      name:  p.properties['학생이름']?.title?.[0]?.text?.content || '',
      type:  p.properties['구분']?.select?.name || '',
      grade: p.properties['학년']?.select?.name || ''
    })).filter(s => s.name);

    return res.status(200).json({ ok: true, students });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
