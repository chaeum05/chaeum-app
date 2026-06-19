export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_QUESTIONS  = process.env.NOTION_DB_EXAM_QUESTIONS;
  const DB_RESULTS    = process.env.NOTION_DB_EXAM_RESULTS;
  const CLAUDE_KEY    = process.env.CLAUDE_API_KEY;

  if (!NOTION_TOKEN || !DB_QUESTIONS || !DB_RESULTS) {
    return res.status(500).json({ error: '환경변수를 확인해주세요.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const { action } = req.body;

  try {

    // ── 시험 목록 조회 ──
    if (action === 'get_exam_list') {
      let allResults = [], cursor;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_QUESTIONS}/query`, {
          method: 'POST', headers, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.object === 'error') throw new Error(d.message);
        allResults = allResults.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      const examSet = new Set();
      allResults.forEach(p => {
        const name = p.properties['시험명']?.title?.[0]?.text?.content || '';
        if (name) examSet.add(name);
      });
      return res.status(200).json({ ok: true, exams: [...examSet].sort() });
    }

    // ── 시험 문항 상세 조회 ──
    if (action === 'get_exam_details') {
      const { examId } = req.body;
      let allResults = [], cursor;
      do {
        const body = {
          page_size: 100,
          filter: { property: '시험명', title: { equals: examId } },
          sorts: [{ property: '문항번호', direction: 'ascending' }]
        };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_QUESTIONS}/query`, {
          method: 'POST', headers, body: JSON.stringify(body)
        });
        const d = await r.json();
        allResults = allResults.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      const questions = allResults.map(p => ({
        num:    p.properties['문항번호']?.number || 0,
        unit:   p.properties['단원']?.rich_text?.[0]?.text?.content || '',
        area:   p.properties['영역']?.rich_text?.[0]?.text?.content || '',
        type:   p.properties['유형']?.rich_text?.[0]?.text?.content || '',
        score:  p.properties['배점']?.number || 0,
        common: p.properties['총평']?.rich_text?.[0]?.text?.content || '',
      })).sort((a,b) => a.num - b.num);

      return res.status(200).json({ ok: true, questions });
    }

    // ── 시험 문항 등록/수정 ──
    if (action === 'save_exam_question') {
      const { examId, num, unit, area, type, score, common, id } = req.body;
      const props = {
        '시험명':   { title:     [{ text: { content: examId || '' } }] },
        '문항번호': { number:    Number(num) || 0 },
        '단원':     { rich_text: [{ text: { content: unit   || '' } }] },
        '영역':     { rich_text: [{ text: { content: area   || '' } }] },
        '유형':     { rich_text: [{ text: { content: type   || '' } }] },
        '배점':     { number:    Number(score) || 0 },
        '총평':     { rich_text: [{ text: { content: common || '' } }] },
      };
      if (id) {
        await fetch(`https://api.notion.com/v1/pages/${id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ properties: props })
        });
      } else {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({ parent: { database_id: DB_QUESTIONS }, properties: props })
        });
      }
      return res.status(200).json({ ok: true, message: '저장 완료' });
    }

    // ── 시험지 일괄 등록 (CSV 파싱 후) ──
    if (action === 'bulk_save_exam') {
      const { examId, questions } = req.body;
      // 기존 문항 삭제
      const existRes = await fetch(`https://api.notion.com/v1/databases/${DB_QUESTIONS}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({ filter: { property: '시험명', title: { equals: examId } } })
      });
      const existData = await existRes.json();
      await Promise.all((existData.results || []).map(p =>
        fetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH', headers, body: JSON.stringify({ archived: true })
        })
      ));
      // 새로 등록
      for (const q of questions) {
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({
            parent: { database_id: DB_QUESTIONS },
            properties: {
              '시험명':   { title:     [{ text: { content: examId } }] },
              '문항번호': { number:    Number(q.num) || 0 },
              '단원':     { rich_text: [{ text: { content: q.unit   || '' } }] },
              '영역':     { rich_text: [{ text: { content: q.area   || '' } }] },
              '유형':     { rich_text: [{ text: { content: q.type   || '' } }] },
              '배점':     { number:    Number(q.score) || 0 },
              '총평':     { rich_text: [{ text: { content: q.common || '' } }] },
            }
          })
        });
      }
      return res.status(200).json({ ok: true, message: `${questions.length}문항 등록 완료` });
    }

    // ── 학생 성적 저장 ──
    if (action === 'save_student_results') {
      const { studentName, examId, results, feedback, extraScore } = req.body;

      // 기존 기록 삭제
      let cursor;
      do {
        const body = {
          page_size: 100,
          filter: {
            and: [
              { property: '학생이름', rich_text: { equals: studentName } },
              { property: '시험명',   rich_text: { equals: examId } },
            ]
          }
        };
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DB_RESULTS}/query`, {
          method: 'POST', headers, body: JSON.stringify(body)
        });
        const d = await r.json();
        await Promise.all((d.results || []).map(p =>
          fetch(`https://api.notion.com/v1/pages/${p.id}`, {
            method: 'PATCH', headers, body: JSON.stringify({ archived: true })
          })
        ));
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);

      // 새 기록 저장
      for (const res_item of results) {
        const recordId = `${studentName}_${examId}_${res_item.num}`;
        await fetch('https://api.notion.com/v1/pages', {
          method: 'POST', headers,
          body: JSON.stringify({
            parent: { database_id: DB_RESULTS },
            properties: {
              '기록ID':   { title:     [{ text: { content: recordId } }] },
              '학생이름': { rich_text: [{ text: { content: studentName } }] },
              '시험명':   { rich_text: [{ text: { content: examId } }] },
              '문항번호': { number:    Number(res_item.num) || 0 },
              '단원':     { rich_text: [{ text: { content: res_item.unit  || '' } }] },
              '영역':     { rich_text: [{ text: { content: res_item.area  || '' } }] },
              '유형':     { rich_text: [{ text: { content: res_item.type  || '' } }] },
              '배점':     { number:    Number(res_item.score) || 0 },
              '정오답':   { select:    { name: res_item.result } },
              '피드백':   { rich_text: [{ text: { content: feedback || '' } }] },
              '추가점수': { number:    Number(extraScore) || 0 },
            }
          })
        });
      }
      return res.status(200).json({ ok: true, message: `${studentName} 학생 저장 완료` });
    }

    // ── 제출 학생 목록 ──
    if (action === 'get_submitted_students') {
      const { examId } = req.body;
      const r = await fetch(`https://api.notion.com/v1/databases/${DB_RESULTS}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { property: '시험명', rich_text: { equals: examId } },
          page_size: 100
        })
      });
      const d = await r.json();
      const names = [...new Set((d.results || []).map(p =>
        p.properties['학생이름']?.rich_text?.[0]?.text?.content || ''
      ).filter(Boolean))].sort((a,b) => a.localeCompare(b,'ko'));
      return res.status(200).json({ ok: true, students: names });
    }

    // ── 기존 학생 데이터 불러오기 ──
    if (action === 'get_existing_data') {
      const { studentName, examId } = req.body;
      const r = await fetch(`https://api.notion.com/v1/databases/${DB_RESULTS}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '학생이름', rich_text: { equals: studentName } },
              { property: '시험명',   rich_text: { equals: examId } },
            ]
          }
        })
      });
      const d = await r.json();
      const results = {}, rows = d.results || [];
      let feedback = '', extraScore = 0;
      rows.forEach(p => {
        const num    = p.properties['문항번호']?.number;
        const result = p.properties['정오답']?.select?.name || '';
        if (num) results[num] = result;
        feedback   = p.properties['피드백']?.rich_text?.[0]?.text?.content || '';
        extraScore = p.properties['추가점수']?.number || 0;
      });
      return res.status(200).json({ ok: true, results, feedback, extraScore });
    }

    // ── 리포트 데이터 생성 ──
    if (action === 'get_report_data') {
      const { studentName, examId } = req.body;

      // 문항 정보
      const qRes = await fetch(`https://api.notion.com/v1/databases/${DB_QUESTIONS}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { property: '시험명', title: { equals: examId } },
          sorts: [{ property: '문항번호', direction: 'ascending' }]
        })
      });
      const qData = await qRes.json();
      const questions = (qData.results || []).map(p => ({
        num:    p.properties['문항번호']?.number || 0,
        unit:   p.properties['단원']?.rich_text?.[0]?.text?.content || '',
        area:   p.properties['영역']?.rich_text?.[0]?.text?.content || '',
        type:   p.properties['유형']?.rich_text?.[0]?.text?.content || '',
        score:  p.properties['배점']?.number || 0,
        common: p.properties['총평']?.rich_text?.[0]?.text?.content || '',
      }));
      const commonComment = questions.find(q => q.common)?.common || '';

      // 학생 결과
      const rRes = await fetch(`https://api.notion.com/v1/databases/${DB_RESULTS}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '학생이름', rich_text: { equals: studentName } },
              { property: '시험명',   rich_text: { equals: examId } },
            ]
          }
        })
      });
      const rData = await rRes.json();
      const rows = rData.results || [];
      if (!rows.length) return res.status(404).json({ error: '데이터 없음' });

      let totalScore = 0, incorrectList = [];
      const teacherFeedback = rows[0].properties['피드백']?.rich_text?.[0]?.text?.content || '';
      const extraScore      = rows[0].properties['추가점수']?.number || 0;

      rows.forEach(p => {
        const score  = p.properties['배점']?.number || 0;
        const result = p.properties['정오답']?.select?.name || '';
        if (result === 'O') {
          totalScore += score;
        } else {
          incorrectList.push({
            num:  p.properties['문항번호']?.number,
            unit: p.properties['단원']?.rich_text?.[0]?.text?.content || '',
            area: p.properties['영역']?.rich_text?.[0]?.text?.content || '',
            type: p.properties['유형']?.rich_text?.[0]?.text?.content || '',
          });
        }
      });
      incorrectList.sort((a,b) => a.num - b.num);

      // 단원별 문항 수 차트
      const unitCount = {};
      questions.forEach(q => {
        if (q.unit) unitCount[q.unit] = (unitCount[q.unit] || 0) + 1;
      });

      // 영역별 비중 차트 (출제영역 기준)
      const areaCount = {};
      questions.forEach(q => {
        if (q.area) areaCount[q.area] = (areaCount[q.area] || 0) + 1;
      });

      return res.status(200).json({
        ok: true,
        studentName, examId,
        totalScore: Number((totalScore + extraScore).toFixed(1)),
        maxScore: 100,
        incorrectList,
        commonComment,
        teacherFeedback,
        unitLabels: Object.keys(unitCount),
        unitValues: Object.values(unitCount),
        areaLabels: Object.keys(areaCount),
        areaValues: Object.values(areaCount),
      });
    }

    // ── AI 피드백 생성 ──
    if (action === 'generate_ai_feedback') {
      if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API 키 없음' });
      const { studentName, examId, totalScore, incorrectList, teacherMemo } = req.body;

      const incorrectSummary = incorrectList.length === 0
        ? '모든 문항 정답 (만점)'
        : incorrectList.map(i => `${i.num}번(${i.area}/${i.type})`).join(', ');

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `채움영어학원 선생님입니다. 아래 학생의 시험 결과를 바탕으로 학부모 전달용 피드백을 3~4문장으로 작성해 주세요.

학생: ${studentName}
시험명: ${examId}
점수: ${totalScore}점 / 100점
오답 문항: ${incorrectSummary}
선생님 메모: ${teacherMemo || '없음'}

[작성 규칙]
- 학부모에게 전달하는 따뜻하고 전문적인 어투
- 오답 문항의 영역/유형을 구체적으로 언급
- 잘한 점과 보완점 균형있게 서술
- "숙제"→"과제", "~것 같습니다"→"~합니다" (단정적으로)
- 마크다운 기호 없이 본문만`
          }]
        })
      });
      const claudeData = await claudeRes.json();
      const feedback = claudeData.content?.[0]?.text?.trim();
      if (!feedback) throw new Error('Claude 응답 오류');
      return res.status(200).json({ ok: true, feedback });
    }

    return res.status(400).json({ error: '알 수 없는 action' });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
