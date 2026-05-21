export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_LOGS       = process.env.NOTION_DB_LOGS;
  const DB_STUDENTS   = process.env.NOTION_DB_STUDENTS;

  if (!NOTION_TOKEN || !DB_LOGS || !DB_STUDENTS) {
    return res.status(500).json({ error: 'Vercel 환경변수가 설정되지 않았습니다.' });
  }

  const data = req.body;
  if (!data.name) return res.status(400).json({ error: '이름이 없습니다.' });

  const notionHeaders = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  try {
    // 1. 학생 페이지 찾거나 생성
    const searchRes = await fetch(`https://api.notion.com/v1/databases/${DB_STUDENTS}/query`, {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify({
        filter: { and: [
          { property: '학생이름', title: { equals: data.name } },
          { property: '구분', select: { equals: data.type } }
        ]}
      })
    });
    const searchData = await searchRes.json();

    let studentPageId;
    if (searchData.results && searchData.results.length > 0) {
      studentPageId = searchData.results[0].id;
    } else {
      const emoji = data.type === '초등' ? '🌱' : data.type === '중등' ? '📖' : '🎓';
      const newStudent = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
          parent: { database_id: DB_STUDENTS },
          icon: { type: 'emoji', emoji },
          properties: {
            '학생이름': { title: [{ text: { content: data.name } }] },
            '구분':     { select: { name: data.type } },
            '학년':     { select: { name: data.grade } }
          },
          children: [
            { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '📋 학습 기록' } }] } },
            { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '수업 기록이 자동으로 추가됩니다.' }, annotations: { color: 'gray' } }] } },
            { object: 'block', type: 'divider', divider: {} }
          ]
        })
      });
      const newStudentData = await newStudent.json();
      studentPageId = newStudentData.id;
    }

    // 2. 학습기록 DB에 행 추가
    const subjects = ['word','grammar','reading','listening','writing']
      .filter(k => data[k])
      .map(k => ({ word:'단어', grammar:'문법', reading:'독해', listening:'듣기', writing:'라이팅' }[k]))
      .join(' · ');
    const title = `${data.name} — ${subjects || '수업기록'} (${data.date})`;

    const logRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: DB_LOGS },
        properties: {
          '기록제목': { title: [{ text: { content: title } }] },
          '날짜':     { date: { start: data.date } },
          '구분':     { select: { name: data.type } },
          '학년':     { select: { name: data.grade } },
          '이름':     { rich_text: [{ text: { content: data.name } }] },
          '단어':     { rich_text: [{ text: { content: data.word || '' } }] },
          '문법':     { rich_text: [{ text: { content: data.grammar || '' } }] },
          '독해':     { rich_text: [{ text: { content: data.reading || '' } }] },
          '듣기':     { rich_text: [{ text: { content: data.listening || '' } }] },
          '라이팅':   { rich_text: [{ text: { content: data.writing || '' } }] },
          '특이사항': { rich_text: [{ text: { content: data.note || '' } }] }
        }
      })
    });
    const logData = await logRes.json();
    if (logData.object === 'error') throw new Error(logData.message);

    // 3. 학생 개별 페이지에 블록 추가
    const lines = [
      data.word      && `📝 단어: ${data.word}`,
      data.grammar   && `📐 문법: ${data.grammar}`,
      data.reading   && `📖 독해: ${data.reading}`,
      data.listening && `🎧 듣기: ${data.listening}`,
      data.writing   && `✍️ 라이팅: ${data.writing}`,
      data.note      && `💬 메모: ${data.note}`
    ].filter(Boolean);

    await fetch(`https://api.notion.com/v1/blocks/${studentPageId}/children`, {
      method: 'PATCH',
      headers: notionHeaders,
      body: JSON.stringify({
        children: [
          { object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: `📅 ${data.date}  (${data.grade})` }, annotations: { bold: true } }] } },
          ...lines.map(l => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: l } }] } })),
          { object: 'block', type: 'divider', divider: {} }
        ]
      })
    });

    return res.status(200).json({ ok: true, message: '✅ 노션에 저장 완료!' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
