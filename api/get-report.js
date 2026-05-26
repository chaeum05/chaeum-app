export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_LOGS       = process.env.NOTION_DB_LOGS;
  const DB_ATTENDANCE = process.env.NOTION_DB_ATTENDANCE;

  if (!NOTION_TOKEN || !DB_LOGS) {
    return res.status(500).json({ error: 'Vercel 환경변수가 설정되지 않았습니다.' });
  }

  const { name, type, start, end } = req.body;
  if (!name || !type || !start || !end) {
    return res.status(400).json({ error: '필수 파라미터가 없습니다.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  try {
    // 1. 학습 기록 조회
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${DB_LOGS}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({
        filter: { and: [
          { property: '이름',  rich_text: { equals: name } },
          { property: '구분',  select: { equals: type } },
          { property: '날짜',  date: { on_or_after: start } },
          { property: '날짜',  date: { on_or_before: end } }
        ]},
        sorts: [{ property: '날짜', direction: 'ascending' }]
      })
    });

    const queryData = await queryRes.json();
    if (queryData.object === 'error') throw new Error(queryData.message);
    if (!queryData.results.length) {
      return res.status(404).json({ error: `${start} ~ ${end} 기간에 ${name} 학생 기록이 없습니다.` });
    }

    const words=[], grammars=[], readings=[], listenings=[], writings=[], notes=[];
    let grade = '';
    queryData.results.forEach(p => {
      const props = p.properties;
      grade = props['학년']?.select?.name || grade;
      const g = k => props[k]?.rich_text?.[0]?.text?.content || '';
      if (g('단어'))     words.push(g('단어'));
      if (g('문법'))     grammars.push(g('문법'));
      if (g('독해'))     readings.push(g('독해'));
      if (g('듣기'))     listenings.push(g('듣기'));
      if (g('라이팅'))   writings.push(g('라이팅'));
      if (g('특이사항')) notes.push(g('특이사항'));
    });

    // 2. 출결 기록 조회 (기간 내)
    let attendanceInfo = [];
    if (DB_ATTENDANCE) {
      const attRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '날짜', date: { on_or_after: start } },
            { property: '날짜', date: { on_or_before: end } }
          ]},
          sorts: [{ property: '날짜', direction: 'ascending' }]
        })
      });
      const attData = await attRes.json();
      attendanceInfo = (attData.results || []).map(p => ({
        date:   p.properties['날짜']?.date?.start || '',
        status: p.properties['출결상태']?.select?.name || '',
        memo:   p.properties['메모']?.rich_text?.[0]?.text?.content || '',
      })).filter(a => a.date && a.status);

      // 이 기간 이후 예정된 보강도 조회 (결석 후 보강날짜가 기간 밖일 수 있음)
      const makeupRes = await fetch(`https://api.notion.com/v1/databases/${DB_ATTENDANCE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { and: [
            { property: '학생이름', rich_text: { equals: name } },
            { property: '출결상태', select: { equals: '보강' } },
            { property: '날짜', date: { on_or_after: start } }
          ]},
          sorts: [{ property: '날짜', direction: 'ascending' }]
        })
      });
      const makeupData = await makeupRes.json();
      const makeupScheduled = (makeupData.results || []).map(p => ({
        date:       p.properties['날짜']?.date?.start || '',
        status:     '보강예정',
        absentDate: p.properties['원래날짜']?.date?.start || '',
        memo:       p.properties['메모']?.rich_text?.[0]?.text?.content || '',
      })).filter(a => a.date && !attendanceInfo.find(x => x.date === a.date && x.status === '보강'));

      attendanceInfo = [...attendanceInfo, ...makeupScheduled];
    }

    return res.status(200).json({
      ok: true, grade, words, grammars, readings, listenings, writings, notes,
      attendanceInfo,
      count: queryData.results.length
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
