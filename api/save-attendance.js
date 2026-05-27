export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_ATTENDANCE = process.env.NOTION_DB_ATTENDANCE;

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const { action, name, type, grade, date, status, memo, absentDate } = req.body;

  try {
    // 1. 출결/보강 기록 저장 및 업데이트
    if (action === 'upsert') {
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '날짜',     date:      { equals: date } },
            { property: '출결상태', select:    { equals: status } }
          ]}
        })
      });
      const searchData = await searchRes.json();
      const title = `${name} — ${status} (${date})`;

      if (searchData.results?.length > 0) {
        await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            properties: {
              '기록제목': { title: [{ text: { content: title } }] },
              '메모':     { rich_text: [{ text: { content: memo || '' } }] }
            }
          })
        });
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
      }
      return res.status(200).json({ ok: true });
    }

    // 2. 보강 기록만 삭제 (결석 기록은 보존)
    if (action === 'delete_by_date') {
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '날짜',     date:      { equals: date } },
            { property: '출결상태', select:    { equals: '보강' } }
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
      return res.status(200).json({ ok: true });
    }

    // 3. 보강 완료 처리 (상태를 보강 -> 출석으로 변경)
    if (action === 'complete_makeup') {
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '날짜',     date:      { equals: date } },
            { property: '출결상태', select:    { equals: '보강' } }
          ]}
        })
      });
      const searchData = await searchRes.json();
      if (searchData.results?.length > 0) {
        await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            properties: {
              '출결상태': { select: { name: '출석' } },
              '기록제목': { title: [{ text: { content: `${name} — 출석(보강완료) (${date})` } }] }
            }
          })
        });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '잘못된 액션' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
