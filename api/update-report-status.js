export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DB_REPORT    = process.env.NOTION_DB_REPORT_STATUS;

  if (!NOTION_TOKEN || !DB_REPORT) {
    return res.status(500).json({ error: '환경변수가 설정되지 않았습니다. NOTION_DB_REPORT_STATUS를 확인해주세요.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const { action, name, type, grade, status, reportType, baseDate } = req.body;

  try {
    // ── 상태 업데이트 ──
    if (action === 'update_status') {
      // 기존 기록 찾기: 이름 + 구분 + 학년 + 보고서종류 + 기준일
      const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_REPORT}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '학생이름',   title:  { equals: name } },
              { property: '구분',       select: { equals: type } },
              { property: '학년',       select: { equals: grade } },
              { property: '보고서종류', select: { equals: reportType } },
              { property: '기준일',     date:   { on_or_after:  baseDate } },
              { property: '기준일',     date:   { on_or_before: baseDate } },
            ]
          }
        })
      });
      const searchData = await searchRes.json();

      if (searchData.results?.length > 0) {
        await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({
            properties: {
              '보고서상태': { select: { name: status } },
            }
          })
        });
      } else {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({
            parent: { database_id: DB_REPORT },
            properties: {
              '학생이름':   { title:  [{ text: { content: name } }] },
              '구분':       { select: { name: type } },
              '학년':       { select: { name: grade } },
              '보고서상태': { select: { name: status } },
              '보고서종류': { select: { name: reportType } },
              '기준일':     { date:   { start: baseDate } },
            }
          })
        });
      }
      return res.status(200).json({ ok: true });
    }

    // ── 현황 조회 ──
    if (action === 'get_status') {
      // 날짜 equals 대신 on_or_after + on_or_before 사용 (timezone 이슈 방지)
      const queryRes = await fetch(`https://api.notion.com/v1/databases/${DB_REPORT}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          page_size: 100,
          filter: {
            and: [
              { property: '보고서종류', select: { equals: reportType } },
              { property: '기준일',     date:   { on_or_after:  baseDate } },
              { property: '기준일',     date:   { on_or_before: baseDate } },
            ]
          }
        })
      });
      const queryData = await queryRes.json();

      if (queryData.object === 'error') {
        return res.status(500).json({ error: queryData.message });
      }

      const statusMap = {};
      (queryData.results || []).forEach(p => {
        const n = p.properties['학생이름']?.title?.[0]?.text?.content || '';
        const t = p.properties['구분']?.select?.name || '';
        const g = p.properties['학년']?.select?.name || '';
        const s = p.properties['보고서상태']?.select?.name || '미작성';
        if (n) statusMap[`${n}_${t}_${g}`] = { status: s, id: p.id };
      });
      return res.status(200).json({ ok: true, statusMap });
    }

    // ── 일괄 초기화 ──
    if (action === 'reset_all') {
      const queryRes = await fetch(`https://api.notion.com/v1/databases/${DB_REPORT}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '보고서종류', select: { equals: reportType } },
              { property: '기준일',     date:   { on_or_after:  baseDate } },
              { property: '기준일',     date:   { on_or_before: baseDate } },
            ]
          }
        })
      });
      const queryData = await queryRes.json();
      await Promise.all((queryData.results || []).map(p =>
        fetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ properties: { '보고서상태': { select: { name: '미작성' } } } })
        })
      ));
      return res.status(200).json({ ok: true, message: `${queryData.results?.length || 0}개 초기화 완료` });
    }

    return res.status(400).json({ error: '알 수 없는 action' });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
