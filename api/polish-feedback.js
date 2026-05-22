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
        max_tokens: 600,
        messages: [{
          role: 'user',
          content:

        `당신은 채움영어학원의 원장입니다. 아래 수업 메모를 바탕으로 학부모에게 전달할 피드백을 작성해주세요.

학생: ${grade} ${name} (${typeLabel})

수업 메모:

${notes.join('\n')}

[작성 규칙]
- 5~7문장으로 작성
- 이번 주 수업에서 배운 구체적인 내용(교재명, 문법 항목 등)이 있다면 반드시 언급
- 잘한 점과 보완이 필요한 점을 균형 있게 서술
- 마크다운 기호 없이 본문만 작성
- 인사말이나 서명 불필요

[반드시 지켜야 할 어투]
- "숙제" → "과제"
- "내어드렸습니다" → "주었습니다"
- "도와드리겠습니다" → "지도하겠습니다"
- "해드렸습니다" → "진행하였습니다"
- "~것 같습니다" → "~합니다" (단정적으로)
- 존댓말 유지, 격식체 사용 (습니다/입니다 체)
- 과도한 칭찬 표현 지양 (예: "정말 훌륭합니다" 대신 구체적 서술)`
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
