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

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action, name, type, grade, status, reportType, baseDate } = body;

  // ── 공통 헬퍼 ──
  const notion = async (url, method, payload) => {
    const r = await fetch(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
    const d = await r.json();
    if (d.object === 'error') throw new Error(d.message);
    return d;
  };

  // 긴 텍스트 → 노션 rich_text 조각 (2000자씩, 최대 25조각 = 5만자)
  const toRichText = (str) => {
    const s = String(str || '');
    const parts = [];
    for (let i = 0; i < s.length && parts.length < 25; i += 2000) {
      parts.push({ text: { content: s.slice(i, i + 2000) } });
    }
    return parts;
  };
  const fromRichText = (arr) => (arr || []).map(t => t.plain_text ?? t.text?.content ?? '').join('');

  // 전체 페이지 조회 (100개 넘어도 전부)
  const queryAll = async (q) => {
    let all = [], cursor;
    do {
      const payload = { page_size: 100, ...q };
      if (cursor) payload.start_cursor = cursor;
      const d = await notion(`https://api.notion.com/v1/databases/${DB_REPORT}/query`, 'POST', payload);
      all = all.concat(d.results || []);
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);
    return all;
  };

  // 학생 + 보고서종류 + 기준일로 행 찾아서 수정, 없으면 새로 만들기
  const upsertRow = async (props) => {
    const rows = await queryAll({
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
    });
    if (rows.length > 0) {
      await notion(`https://api.notion.com/v1/pages/${rows[0].id}`, 'PATCH', { properties: props });
    } else {
      await notion('https://api.notion.com/v1/pages', 'POST', {
        parent: { database_id: DB_REPORT },
        properties: {
          '학생이름':   { title:  [{ text: { content: name } }] },
          '구분':       { select: { name: type } },
          '학년':       { select: { name: grade } },
          '보고서종류': { select: { name: reportType } },
          '기준일':     { date:   { start: baseDate } },
          ...props,
        }
      });
    }
  };

  try {
    // ── 상태 업데이트 ──
    if (action === 'update_status') {
      await upsertRow({ '보고서상태': { select: { name: status } } });
      return res.status(200).json({ ok: true });
    }

    // ── 발송함에 담기: 보고서 카드 저장 + 생성완료 ──
    if (action === 'save_draft') {
      const { html, feedback } = body;
      if (!name || !type || !reportType || !baseDate) return res.status(400).json({ error: '학생 정보가 부족합니다.' });
      if (!html) return res.status(400).json({ error: '보고서 내용이 없습니다.' });
      await upsertRow({
        '보고서상태':   { select: { name: '생성완료' } },
        '보고서데이터': { rich_text: toRichText(html) },
        '피드백':       { rich_text: toRichText(String(feedback || '').slice(0, 2000)) },
      });
      return res.status(200).json({ ok: true });
    }

    // ── 발송함 조회: 생성완료 + 보고서 저장된 것 전부 ──
    if (action === 'get_outbox') {
      const rows = await queryAll({
        filter: {
          and: [
            { property: '보고서상태',   select:    { equals: '생성완료' } },
            { property: '보고서데이터', rich_text: { is_not_empty: true } },
          ]
        },
        sorts: [{ property: '기준일', direction: 'ascending' }]
      });
      const items = rows.map(p => {
        const pr = p.properties;
        const item = {
          id:         p.id,
          name:       fromRichText(pr['학생이름']?.title),
          type:       pr['구분']?.select?.name || '',
          grade:      pr['학년']?.select?.name || '',
          reportType: pr['보고서종류']?.select?.name || '',
          baseDate:   pr['기준일']?.date?.start || '',
        };
        if (!body.summary) item.html = fromRichText(pr['보고서데이터']?.rich_text);
        return item;
      }).filter(i => i.name);
      return res.status(200).json({ ok: true, items });
    }

    // ── 현황 조회 ──
    if (action === 'get_status') {
      const rows = await queryAll({
        filter: {
          and: [
            { property: '보고서종류', select: { equals: reportType } },
            { property: '기준일',     date:   { on_or_after:  baseDate } },
            { property: '기준일',     date:   { on_or_before: baseDate } },
          ]
        }
      });
      const statusMap = {};
      rows.forEach(p => {
        const n = fromRichText(p.properties['학생이름']?.title);
        const t = p.properties['구분']?.select?.name || '';
        const g = p.properties['학년']?.select?.name || '';
        const s = p.properties['보고서상태']?.select?.name || '미작성';
        const hasDraft = (p.properties['보고서데이터']?.rich_text || []).length > 0;
        if (n) statusMap[`${n}_${t}_${g}`] = { status: s, id: p.id, hasDraft };
      });
      return res.status(200).json({ ok: true, statusMap });
    }

    // ── 일괄 초기화 ──
    if (action === 'reset_all') {
      const rows = await queryAll({
        filter: {
          and: [
            { property: '보고서종류', select: { equals: reportType } },
            { property: '기준일',     date:   { on_or_after:  baseDate } },
            { property: '기준일',     date:   { on_or_before: baseDate } },
          ]
        }
      });
      await Promise.all(rows.map(p =>
        fetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ properties: { '보고서상태': { select: { name: '미작성' } } } })
        })
      ));
      return res.status(200).json({ ok: true, message: `${rows.length}개 초기화 완료` });
    }

    return res.status(400).json({ error: '알 수 없는 action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
