export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API 키가 설정되지 않았습니다.' });

  const { notes, name, grade, type, attendanceInfo } = req.body;
  if (!notes || !notes.length) return res.status(400).json({ error: '메모가 없습니다.' });

  const typeLabel = type === '초등' ? '초등학생' : type === '중등' ? '중학생' : '고등학생';

  // 출결 정보 텍스트 구성
  let attendanceText = '';
  if (attendanceInfo && attendanceInfo.length) {
    const dayKor = d => {
      const day = new Date(d+'T00:00:00').getDay();
      return ['일','월','화','수','목','금','토'][day];
    };
    const fmt = d => {
      const [,m,dd] = d.split('-');
      return `${parseInt(m)}월 ${parseInt(dd)}일(${dayKor(d)})`;
    };

    const absent  = attendanceInfo.filter(a => a.status === '결석');
    const makeup  = attendanceInfo.filter(a => a.status === '보강' || a.status === '보강예정');

    const parts = [];
    absent.forEach(a => {
      const makeupForThis = makeup.find(m => m.absentDate === a.date);
      if (makeupForThis) {
        parts.push(`${fmt(a.date)} 결석 (${a.memo||'사유 미기재'}), ${fmt(makeupForThis.date)} 보강 예정`);
      } else {
        parts.push(`${fmt(a.date)} 결석 (${a.memo||'사유 미기재'}), 보강 미정`);
      }
    });
    // 결석 없이 보강만 있는 경우 (사전 보강 등)
    makeup.filter(m => !absent.find(a => a.date === m.absentDate)).forEach(m => {
      parts.push(`${fmt(m.date)} 보강 수업 진행 (${m.memo||''})`);
    });

    if (parts.length) {
      attendanceText = `\n출결 정보:\n${parts.join('\n')}`;
    }
  }

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
          content: `당신은 채움영어학원의 원장입니다. 아래 수업 메모를 바탕으로 학부모에게 전달할 피드백을 작성해주세요.

학생: ${grade} ${name} (${typeLabel})
수업 메모:
${notes.join('\n')}${attendanceText}

[작성 규칙]
- 5~7문장으로 작성 (너무 길지 않게, 핵심만 간결하게)
- 이번 주 수업에서 배운 구체적인 내용(교재명, 문법 항목 등)을 반드시 언급
- 잘한 점과 보완이 필요한 점을 균형 있게 서술
- 출결 정보가 있는 경우: 결석일, 보강 예정일을 자연스럽게 문장에 녹여서 마지막에 안내 (예: "X월 X일(X요일)에 결석하여 X월 X일(X요일)에 보강 수업을 진행할 예정입니다.")
- 보강 미정인 경우: "보강 일정은 추후 안내드리겠습니다" 식으로 부드럽게 안내
- 마크다운 기호 없이 본문만, 인사말/서명 불필요

[반드시 지켜야 할 어투]
- "숙제" → "과제"
- "도와드리겠습니다" → "지도하겠습니다"
- "해드렸습니다" → "진행하였습니다"
- "~것 같습니다" → "~합니다" (단정적으로)
- 존댓말 유지, 격식체 (습니다/입니다 체)
- 과도한 칭찬 지양, 구체적으로 서술`
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
