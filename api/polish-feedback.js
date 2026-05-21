export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API 키가 설정되지 않았습니다.' });

  const { notes, name, grade, type } = req.body;
  if (!notes || !notes.length) return res.status(400).json({ error: '메모가 없습니다.' });

  const typeLabel = type === '초등' ? '초등학생' : type === '중등' ? '중학생' : '고등학생';

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `당신은 영어학원 원장입니다. 아래 수업 메모를 바탕으로 학부모에게 전달할 자연스럽고 따뜻한 피드백을 2~4문장으로 작성해주세요.\n\n학생: ${grade} ${name} (${typeLabel})\n수업 메모:\n${notes.join('\n')}\n\n규칙: 학부모용 어조, 구체적 내용 포함, 마크다운 기호 없이 본문만.`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const feedback = claudeData.content?.[0]?.text?.trim();
    if (!feedback) throw new Error('Claude 응답 오류');

    return res.status(200).json({ ok: true, feedback });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
