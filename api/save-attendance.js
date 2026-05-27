export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_ATTENDANCE = process.env.NOTION_DB_ATTENDANCE;

  if (!NOTION_TOKEN || !DB_ATTENDANCE) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const { action, name, type, grade, date, status, memo, recordId, absentDate } = req.body;

  try {
    // 기존 기록 있는지 확인
    if (action === 'upsert') {
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '학생이름', rich_text: { equals: name } },
              { property: '날짜', date: { equals: date } }
            ]
          }
        })
      });
      const searchData = await searchRes.json();

      const title = `${name} — ${status} (${date})`;

      if (searchData.results && searchData.results.length > 0) {
        // 기존 기록 업데이트
        const existingId = searchData.results[0].id;
        await fetch(`https://api.notion.com/v1/pages/${existingId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            properties: {
              '기록제목': { title: [{ text: { content: title } }] },
              '출결상태': { select: { name: status } },
              '메모':     { rich_text: [{ text: { content: memo || '' } }] },
            }
          })
        });
        return res.status(200).json({ ok: true, message: '출결 기록 업데이트 완료' });
      } else {
        // 새 기록 생성
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
        return res.status(200).json({ ok: true, message: '출결 기록 저장 완료' });
      }
    }

    // 특정 날짜 보강 기록 삭제
    if (action === 'delete_by_date') {
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '날짜', date: { equals: date } },
            { property: '출결상태', select: { equals: status || '보강' } }
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
      return res.status(200).json({ ok: true, message: '삭제 완료' });
    }

    // 보강 대기 삭제
    if (action === 'delete_makeup' && recordId) {
      await fetch(`https://api.notion.com/v1/pages/${recordId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true })
      });
      return res.status(200).json({ ok: true, message: '보강 대기 삭제 완료' });
    }

    // 보강 완료 처리
    if (action === 'complete_makeup' && recordId) {
      await fetch(`https://api.notion.com/v1/pages/${recordId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({
          properties: {
            '출결상태': { select: { name: '보강완료' } },
            '원래날짜': { date: { start: absentDate || date } },
            '날짜':     { date: { start: date } },
          }
        })
      });
      return res.status(200).json({ ok: true, message: '보강 완료 처리되었습니다.' });
    }

    // 등원 일정 저장 (학생 스케줄 등록)
    if (action === 'save_schedule') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      const { days } = req.body; // { 월: true, 화: false, ... }

      // 기존 스케줄 찾기
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_SCHEDULE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '학생이름', title: { equals: name } },
              { property: '구분', select: { equals: type } }
            ]
          }
        })
      });
      const searchData = await searchRes.json();

      const props = {
        '학생이름': { title: [{ text: { content: name } }] },
        '구분':     { select: { name: type } },
        '학년':     { select: { name: grade } },
        '월': { checkbox: days['월'] || false },
        '화': { checkbox: days['화'] || false },
        '수': { checkbox: days['수'] || false },
        '목': { checkbox: days['목'] || false },
        '금': { checkbox: days['금'] || false },
        '메모': { rich_text: [{ text: { content: memo || '' } }] }
      };

      if (searchData.results && searchData.results.length > 0) {
        await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ properties: props })
        });
      } else {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({ parent: { database_id: DB_SCHEDULE }, properties: props })
        });
      }
      return res.status(200).json({ ok: true, message: '등원 일정 저장 완료' });
    }

    return res.status(400).json({ error: '알 수 없는 action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
