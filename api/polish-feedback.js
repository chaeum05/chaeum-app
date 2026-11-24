// 👦 피드백 호칭: "오준석 학생" 대신 "준석이" (받침 있으면 '이' 붙임: 준석→준석이, 민지→민지)
function callName(full) {
  const n = String(full || '').trim().replace(/\s+/g, '');
  const given = /^[가-힣]{4}$/.test(n) ? n.slice(2) : /^[가-힣]{3}$/.test(n) ? n.slice(1) : n;   // 성 빼기 (남궁민수→민수, 2글자 이름은 그대로)
  const last = given.charCodeAt(given.length - 1);
  const batchim = last >= 0xAC00 && last <= 0xD7A3 && (last - 0xAC00) % 28 !== 0;
  return batchim ? given + '이' : given;
}
function nameRule(full) {
  const c = callName(full);
  return `- 학생 호칭: "${full} 학생", "학생은"처럼 쓰지 말고 이름만 친근하게 "${c}"로 부름 (예: "${c}는", "${c}가", "${c}의"). 호칭은 1~2번만 자연스럽게 사용`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API 키가 설정되지 않았습니다.' });

  const { notes, name, grade, type, attendanceInfo, start, end, contents, newbieMode, attitude, adapt, learning, note } = req.body;

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
${nameRule(name)}
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

  // 📌 2026년 10월 고등부 월간 보고서 한정 첫 문장 (10/30까지 만드는 것만 · 10/31부터 자동으로 원래대로)
  const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const OCT_OPENING = '이번 달 수업은 중간고사 학습 이후로 오답을 정리 및 회고지를 작성하여 틀린 유형에 대한 점검을 하였으며,';
  const useOctOpening = type === '고등' && todayKST <= '2026-10-30';
  const openingRule = useOctOpening
    ? `- 첫 문장은 반드시 다음 문구 그대로 시작하고, 이어서 이번 달 학습 내용을 자연스럽게 연결해 한 문장으로 마무리: "${OCT_OPENING}"`
    : `- 반드시 "이번 달 수업에서"로 시작 ("이번 수업에서", "이번 주"는 쓰지 않음)`;

  // 📌 고등부 11월 월간 보고서: 본격 내신대비 달 + 12월 기말고사 안내
  const periodMonth = String(end || start || todayKST).slice(0, 7);
  const novNaesin = type === '고등' && /-11$/.test(periodMonth);
  const novRule = novNaesin ? `
- 이번 달은 기말고사 대비를 본격적으로 진행한 달임을 자연스럽게 담기 (내신 범위 학습·문제 풀이 중심)
- 아래 [이번 달 진도]에서 독해·듣기가 '진도 없음'이면 내신 대비에 집중하느라 해당 과정은 잠시 멈추었다고 짧게 언급, 어휘·문법 진도가 있으면 내신 대비와 함께 필요한 부분은 계속 진행했다고 언급 (진도가 있는 과목을 멈췄다고 쓰지 않음)
- 마지막 문장은 12월에 내신(기말) 시험이 있으므로 마지막까지 내신 대비를 꼼꼼히 하여 좋은 성적을 거둘 수 있도록 지도하겠다는 내용으로 마무리` : '';
  const contentsText = contents ? `\n[이번 달 진도]\n${contents}` : '';

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
        max_tokens: type === '고등' ? 800 : 600,
        messages: [{
          role: 'user',
          content: `당신은 채움영어학원의 원장입니다. 아래 수업 메모를 바탕으로 학부모에게 전달할 피드백을 작성해주세요.

학생: ${grade} ${name} (${typeLabel})
수업 메모:
${notes.join('\n')}${type === '고등' ? contentsText : ''}${attendanceText}

${type === '고등' ? `[작성 규칙 — 고등부 월간 보고서 (한 달에 한 번 보내므로 주간보다 조금 더 자세하게)]
${openingRule}
- 5~7문장, 한 문단으로 작성 (문단 나누지 않음, 너무 길지 않게)
  · 이번 달에 학습한 구체적인 내용(교재명, 단원, 문법 항목 등) → 잘한 점 → 보완이 필요한 점 → 다음 달 학습 방향 순서
- 한 문장은 너무 길지 않게, 같은 내용 반복 없이
- 결석·보강·출결 이야기는 쓰지 않음${novRule}
${nameRule(name)}
- 마크다운 기호 없이 본문만, 인사말/서명 불필요` : `[작성 규칙]
- 3~5문장으로 작성 (너무 길지 않게, 핵심만 간결하게)
- 이번 주 수업에서 배운 구체적인 내용(교재명, 문법 항목 등)을 반드시 언급
- 잘한 점과 보완이 필요한 점을 균형 있게 서술
- 결석·보강·출결 이야기는 쓰지 않음
${nameRule(name)}
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
