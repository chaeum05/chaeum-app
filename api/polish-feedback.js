export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API 키가 설정되지 않았습니다.' });

  const { notes, name, grade, type, attendanceInfo, newbieMode, attitude, adapt, learning, note } = req.body;

  const typeLabel = type === '초등' ? '초등학생' : type === '중등' ? '중학생' : '고등학생';

  // ── 신규생 첫 피드백 모드 ──
  if (newbieMode) {
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `당신은 채움영어학원의 원장입니다. 새로 등록한 학생의 첫 수업 후, 학부모에게 상담 전화 대신 보낼 따뜻한 카카오톡 메시지를 작성해주세요.

학생: ${name} (${typeLabel})
[오늘 첫 수업 관찰]
- 수업 태도: ${attitude}
- 분위기 적응: ${adapt}
- 학습 상태: ${learning}${note ? `\n- 강점/특이사항: ${note}` : ''}

[작성 규칙]
- 첫인사로 시작 ("어머니, 안녕하세요. 채움영어입니다" 등)
- 첫 수업을 잘 마쳤다는 안심의 메시지
- 위 관찰 내용(태도·적응·학습)을 자연스럽게 녹여 3~5문장
- 앞으로 세심하게 지도하겠다는 다짐
- 궁금한 점 문의 안내
- 마지막 줄에 "형곡동은 채움입니다." 서명
- 따뜻하고 진심 어린 어투, 존댓말 격식체
- 과장된 칭찬보다 구체적 관찰 중심
- 마크다운 기호 없이 본문만`
          }]
        })
      });
      const claudeData = await claudeRes.json();
      const feedback = claudeData.content?.[0]?.text?.trim();
      if (!feedback) throw new Error('Claude 응답 오류');
      return res.status(200).json({ ok: true, feedback });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── 일반 보고서 모드 ──
  if (!notes || !notes.length) return res.status(400).json({ error: '메모가 없습니다.' });

  // 출결(결석·보강)은 피드백에 넣지 않음
  let attendanceText = '';
  if (false && attendanceInfo && attendanceInfo.length) {
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
        model: 'claude-sonnet-4-6',
        max_tokens: type === '고등' ? 1100 : 600,
        messages: [{
          role: 'user',
          content: `당신은 채움영어학원의 원장입니다. 아래 수업 메모를 바탕으로 학부모에게 전달할 피드백을 작성해주세요.

학생: ${grade} ${name} (${typeLabel})
수업 메모:
${notes.join('\n')}${attendanceText}

${type === '고등' ? `[작성 규칙 — 고등부 월간 보고서 (한 달에 한 번 보내므로 충분히 자세하게)]
- 반드시 "이번 달 수업에서"로 시작 ("이번 수업에서", "이번 주"는 쓰지 않음)
- 7~10문장, 두 문단으로 작성
  · 첫 문단: 이번 달에 학습한 구체적인 내용(교재명, 단원, 문법 항목, 내신 대비 범위 등)과 그 과정에서 보인 학습 태도·이해도
  · 둘째 문단: 잘한 점과 보완이 필요한 점을 구체적으로, 그리고 다음 달 학습 방향·목표
- 한 달 동안의 흐름(초반 → 후반의 변화)이 드러나게 서술
- 결석·보강·출결 이야기는 쓰지 않음
- 마크다운 기호 없이 본문만, 인사말/서명 불필요` : `[작성 규칙]
- 3~5문장으로 작성 (너무 길지 않게, 핵심만 간결하게)
- 이번 주 수업에서 배운 구체적인 내용(교재명, 문법 항목 등)을 반드시 언급
- 잘한 점과 보완이 필요한 점을 균형 있게 서술
- 결석·보강·출결 이야기는 쓰지 않음
- 마크다운 기호 없이 본문만, 인사말/서명 불필요`}

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
