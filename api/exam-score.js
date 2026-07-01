export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const DB_QUESTIONS = process.env.NOTION_DB_EXAM_QUESTIONS;
  const DB_RESULTS   = process.env.NOTION_DB_EXAM_RESULTS;
  const CLAUDE_KEY   = process.env.CLAUDE_API_KEY;

  if (!NOTION_TOKEN || !DB_QUESTIONS || !DB_RESULTS) {
    return res.status(500).json({ error: '환경변수를 확인해주세요.' });
  }

  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  const nFetch = (url, opts = {}) =>
    fetch(url, { headers, ...opts }).then(r => r.json());

  const queryDB = async (dbId, filter, sorts) => {
    let all = [], cursor;
    do {
      const body = { page_size: 100 };
      if (filter) body.filter = filter;
      if (sorts)  body.sorts  = sorts;
      if (cursor) body.start_cursor = cursor;
      const d = await nFetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST', body: JSON.stringify(body)
      });
      if (d.object === 'error') throw new Error(d.message);
      all = all.concat(d.results || []);
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);
    return all;
  };

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action } = body;

  try {

    // ── 시험 목록 ──
    if (action === 'get_exam_list') {
      let all = [], cursor;
      do {
        const b = { page_size: 100 };
        if (cursor) b.start_cursor = cursor;
        const d = await nFetch(`https://api.notion.com/v1/databases/${DB_QUESTIONS}/query`, {
          method: 'POST', body: JSON.stringify(b)
        });
        if (d.object === 'error') throw new Error(d.message);
        all = all.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : undefined;
      } while (cursor);
      const exams = [...new Set(all.map(p =>
        p.properties['시험명']?.title?.[0]?.text?.content || ''
      ).filter(Boolean))].sort();
      return res.status(200).json({ ok: true, exams });
    }

    // ── 시험 문항 조회 ──
    if (action === 'get_exam_details') {
      const { examId } = body;
      const rows = await queryDB(DB_QUESTIONS,
        { property: '시험명', title: { equals: examId } },
        [{ property: '문항번호', direction: 'ascending' }]
      );
      // 문항번호 숫자인 것 먼저, 서답형/서술형 나중에
      const qs = rows.map(p => ({
        id:     p.id,
        num:    p.properties['문항번호']?.number,
        numStr: p.properties['번호']?.rich_text?.[0]?.text?.content || String(p.properties['문항번호']?.number || ''),
        unit:   p.properties['단원']?.rich_text?.[0]?.text?.content || '',
        area:   p.properties['영역']?.rich_text?.[0]?.text?.content || '',
        type:   p.properties['유형']?.rich_text?.[0]?.text?.content || '',
        score:  p.properties['배점']?.number || 0,
        common: p.properties['총평']?.rich_text?.[0]?.text?.content || '',
      }));
      return res.status(200).json({ ok: true, questions: qs });
    }

    // ── 시험지 삭제 ──
    if (action === 'delete_exam') {
      const { examId } = body;
      const existing = await queryDB(DB_QUESTIONS,
        { property: '시험명', title: { equals: examId } }
      );
      await Promise.all(existing.map(p =>
        nFetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH', body: JSON.stringify({ archived: true })
        })
      ));
      return res.status(200).json({ ok: true, message: `"${examId}" 삭제 완료 (${existing.length}문항)` });
    }

    // ── 시험지 일괄 저장 ──
    if (action === 'bulk_save_exam') {
      const { examId, questions } = body;
      // 기존 삭제
      const existing = await queryDB(DB_QUESTIONS,
        { property: '시험명', title: { equals: examId } }
      );
      await Promise.all(existing.map(p =>
        nFetch(`https://api.notion.com/v1/pages/${p.id}`, {
          method: 'PATCH', body: JSON.stringify({ archived: true })
        })
      ));
      // 새로 저장 (5개씩 병렬)
      for (let i = 0; i < questions.length; i += 5) {
        const batch = questions.slice(i, i + 5);
        await Promise.all(batch.map((q, idx) =>
          nFetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            body: JSON.stringify({
              parent: { database_id: DB_QUESTIONS },
              properties: {
                '시험명':   { title:     [{ text: { content: examId } }] },
                '문항번호': { number:    i + idx + 1 },
                '번호':     { rich_text: [{ text: { content: String(q.num || '') } }] },
                '단원':     { rich_text: [{ text: { content: q.unit   || '' } }] },
                '영역':     { rich_text: [{ text: { content: q.area   || '' } }] },
                '유형':     { rich_text: [{ text: { content: q.type   || '' } }] },
                '배점':     { number:    Number(q.score) || 0 },
                '총평':     { rich_text: [{ text: { content: q.common || '' } }] },
              }
            })
          })
        ));
      }
      return res.status(200).json({ ok: true, message: `${questions.length}문항 저장 완료` });
    }

    // ── 학생 성적 저장 (학생 1명 = 레코드 1개) ──
    if (action === 'save_student_results') {
      const { studentName, examId, results, feedback, extraScore } = body;

      // 정오답을 JSON 문자열로 압축
      const answersJson = JSON.stringify(
        Object.fromEntries(results.map(r => [r.num ?? r.numStr, r.result]))
      );

      // 기존 레코드 삭제
      const existing = await queryDB(DB_RESULTS, {
        and: [
          { property: '학생이름', rich_text: { equals: studentName } },
          { property: '시험명',   rich_text: { equals: examId } },
        ]
      });
      if (existing.length) {
        await Promise.all(existing.map(p =>
          nFetch(`https://api.notion.com/v1/pages/${p.id}`, {
            method: 'PATCH', body: JSON.stringify({ archived: true })
          })
        ));
      }

      // 새 레코드 1개 저장
      await nFetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: DB_RESULTS },
          properties: {
            '기록ID':    { title:     [{ text: { content: `${studentName}_${examId}` } }] },
            '학생이름':  { rich_text: [{ text: { content: studentName } }] },
            '시험명':    { rich_text: [{ text: { content: examId } }] },
            '정오답':    { select:    { name: 'O' } }, // 더미 (스키마 호환)
            '피드백':    { rich_text: [{ text: { content: feedback   || '' } }] },
            '유형':      { rich_text: [{ text: { content: answersJson } }] }, // 정오답 JSON 저장
            '추가점수':  { number:    Number(extraScore) || 0 },
          }
        })
      });

      return res.status(200).json({ ok: true, message: `${studentName} 저장 완료` });
    }

    // ── 제출 학생 목록 ──
    // ── 피드백만 저장 ──
    if (action === 'save_feedback') {
      const { studentName, examId, feedback } = body;
      const rows = await queryDB(DB_RESULTS, {
        and: [
          { property: '학생이름', rich_text: { equals: studentName } },
          { property: '시험명',   rich_text: { equals: examId } },
        ]
      });
      if (!rows.length) return res.status(404).json({ error: '성적 데이터 없음 — 먼저 성적을 저장해주세요.' });
      await nFetch(`https://api.notion.com/v1/pages/${rows[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: { '피드백': { rich_text: [{ text: { content: feedback || '' } }] } }
        })
      });
      return res.status(200).json({ ok: true });
    }

    // ── 제출 학생 목록 (점수 + 피드백 여부 포함) ──
    if (action === 'get_submitted_students') {
      const { examId } = body;
      const [rRows, qRows] = await Promise.all([
        queryDB(DB_RESULTS,   { property: '시험명', rich_text: { equals: examId } }),
        queryDB(DB_QUESTIONS, { property: '시험명', title:     { equals: examId } })
      ]);

      const questions = qRows.map(p => ({
        num:   p.properties['번호']?.rich_text?.[0]?.text?.content || String(p.properties['문항번호']?.number || ''),
        score: p.properties['배점']?.number || 0,
      }));

      const students = rRows.map(p => {
        const name     = p.properties['학생이름']?.rich_text?.[0]?.text?.content || '';
        const feedback = p.properties['피드백']?.rich_text?.[0]?.text?.content || '';
        const extra    = p.properties['추가점수']?.number || 0;
        const answersJson = p.properties['유형']?.rich_text?.[0]?.text?.content || '{}';
        let answers = {};
        try { answers = JSON.parse(answersJson); } catch {}
        let score = extra;
        questions.forEach(q => { if ((answers[q.num] || 'O') === 'O') score += q.score; });
        return { name, score: Number(score.toFixed(1)), hasFeedback: feedback.length > 0 };
      }).filter(s => s.name).sort((a,b) => a.name.localeCompare(b.name, 'ko'));

      return res.status(200).json({ ok: true, students });
    }

    // ── 기존 데이터 불러오기 ──
    if (action === 'get_existing_data') {
      const { studentName, examId } = body;
      const rows = await queryDB(DB_RESULTS, {
        and: [
          { property: '학생이름', rich_text: { equals: studentName } },
          { property: '시험명',   rich_text: { equals: examId } },
        ]
      });
      if (!rows.length) return res.status(200).json({ ok: true, results: {}, feedback: '', extraScore: 0 });
      const row = rows[0];
      const answersJson = row.properties['유형']?.rich_text?.[0]?.text?.content || '{}';
      let results = {};
      try { results = JSON.parse(answersJson); } catch {}
      const feedback   = row.properties['피드백']?.rich_text?.[0]?.text?.content || '';
      const extraScore = row.properties['추가점수']?.number || 0;
      return res.status(200).json({ ok: true, results, feedback, extraScore });
    }

    // ── 리포트 데이터 ──
    if (action === 'get_report_data') {
      const { studentName, examId } = body;

      // 문항 정보
      const qRows = await queryDB(DB_QUESTIONS,
        { property: '시험명', title: { equals: examId } },
        [{ property: '문항번호', direction: 'ascending' }]
      );
      if (!qRows.length) return res.status(404).json({ error: '시험 문항 없음' });

      const questions = qRows.map(p => ({
        num:   p.properties['번호']?.rich_text?.[0]?.text?.content || String(p.properties['문항번호']?.number || ''),
        unit:  p.properties['단원']?.rich_text?.[0]?.text?.content || '',
        area:  p.properties['영역']?.rich_text?.[0]?.text?.content || '',
        type:  p.properties['유형']?.rich_text?.[0]?.text?.content || '',
        score: p.properties['배점']?.number || 0,
      }));
      const commonComment = qRows[0].properties['총평']?.rich_text?.[0]?.text?.content || '';

      // 학생 성적
      const rRows = await queryDB(DB_RESULTS, {
        and: [
          { property: '학생이름', rich_text: { equals: studentName } },
          { property: '시험명',   rich_text: { equals: examId } },
        ]
      });
      if (!rRows.length) return res.status(404).json({ error: '데이터 없음' });

      const row = rRows[0];
      const answersJson = row.properties['유형']?.rich_text?.[0]?.text?.content || '{}';
      const extraScore  = row.properties['추가점수']?.number || 0;
      const teacherFeedback = row.properties['피드백']?.rich_text?.[0]?.text?.content || '';
      let answers = {};
      try { answers = JSON.parse(answersJson); } catch {}

      let totalScore = extraScore;
      const incorrectList = [];
      questions.forEach(q => {
        const result = answers[q.num] || 'O';
        if (result === 'O') {
          totalScore += (q.score || 0);
        } else {
          incorrectList.push({ num: q.num, unit: q.unit, area: q.area, type: q.type, score: q.score });
        }
      });

      // 차트 데이터
      const unitCount = {}, areaCount = {};
      questions.forEach(q => {
        if (q.unit) unitCount[q.unit] = (unitCount[q.unit] || 0) + 1;
        if (q.area) areaCount[q.area] = (areaCount[q.area] || 0) + 1;
      });

      return res.status(200).json({
        ok: true,
        studentName, examId,
        totalScore:    Number(totalScore.toFixed(1)),
        maxScore:      100,
        incorrectList,
        commonComment,
        teacherFeedback,
        unitLabels:  Object.keys(unitCount),
        unitValues:  Object.values(unitCount),
        areaLabels:  Object.keys(areaCount),
        areaValues:  Object.values(areaCount),
      });
    }

    // ── 누적 성적표 ──
    if (action === 'get_score_matrix') {
      const DB_SCHEDULE = process.env.NOTION_DB_SCHEDULE;
      const [rRows, qRows, sRows] = await Promise.all([
        queryDB(DB_RESULTS),
        queryDB(DB_QUESTIONS),
        DB_SCHEDULE ? queryDB(DB_SCHEDULE) : Promise.resolve([])
      ]);

      // 학생 정보 맵 (이름 → type/grade/school)
      const studentInfoMap = {};
      sRows.forEach(p => {
        const name   = p.properties['학생이름']?.title?.[0]?.text?.content?.trim() || '';
        const type   = p.properties['구분']?.select?.name || '';
        const grade  = p.properties['학년']?.select?.name || '';
        const school = p.properties['학교']?.rich_text?.[0]?.text?.content?.trim() || '';
        if (name) studentInfoMap[name] = { type, grade, school };
      });

      // 시험별 문항 정보 맵
      const examQMap = {};
      qRows.forEach(p => {
        const exam  = p.properties['시험명']?.title?.[0]?.text?.content || '';
        const num   = p.properties['번호']?.rich_text?.[0]?.text?.content || String(p.properties['문항번호']?.number || '');
        const score = p.properties['배점']?.number || 0;
        if (!examQMap[exam]) examQMap[exam] = [];
        examQMap[exam].push({ num, score });
      });

      // 시험명 목록 (생성일 순)
      const exams = [...new Set(
        qRows
          .sort((a,b) => new Date(a.created_time||0) - new Date(b.created_time||0))
          .map(p => p.properties['시험명']?.title?.[0]?.text?.content || '')
      )].filter(Boolean);

      // 학생별 시험 점수 계산
      const studentMap = {};
      rRows.forEach(p => {
        const name  = p.properties['학생이름']?.rich_text?.[0]?.text?.content || '';
        const exam  = p.properties['시험명']?.rich_text?.[0]?.text?.content || '';
        const extra = p.properties['추가점수']?.number || 0;
        const answersJson = p.properties['유형']?.rich_text?.[0]?.text?.content || '{}';
        if (!name || !exam) return;
        let answers = {};
        try { answers = JSON.parse(answersJson); } catch {}
        let score = extra;
        (examQMap[exam] || []).forEach(q => { if ((answers[q.num]||'O') === 'O') score += q.score; });
        if (!studentMap[name]) {
          const info = studentInfoMap[name] || {};
          studentMap[name] = { name, type: info.type||'', grade: info.grade||'', school: info.school||'', scores: {} };
        }
        studentMap[name].scores[exam] = Number(score.toFixed(1));
      });

      const rows = Object.values(studentMap).sort((a,b) => {
        const to = {'초등':0,'중등':1,'고등':2};
        const ta = to[a.type]??3, tb = to[b.type]??3;
        if (ta !== tb) return ta - tb;
        if (a.school !== b.school) return a.school.localeCompare(b.school,'ko');
        const ga = parseInt(a.grade)||0, gb = parseInt(b.grade)||0;
        if (ga !== gb) return ga - gb;
        return a.name.localeCompare(b.name,'ko');
      });
      return res.status(200).json({ ok: true, exams, rows });
    }

    // ── 시험 총평 AI 생성 (생성만, 저장은 시험지 저장 버튼으로) ──
    if (action === 'generate_common_comment') {
      if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API 키 없음' });
      const { prompt } = body;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:400, messages:[{role:'user',content:prompt}] })
      });
      const data = await r.json();
      const text = data.content?.[0]?.text?.trim();
      if (!text) throw new Error('Claude 응답 오류');
      return res.status(200).json({ ok: true, text });
    }

    if (action === 'generate_ai_feedback') {
      if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API 키 없음' });
      const { studentName, examId, totalScore, incorrectList, teacherMemo, hasTeacherMemo } = body;
      const incorrectSummary = !incorrectList?.length
        ? '모든 문항 정답'
        : incorrectList.map(i => `${i.num}번(${i.area}/${i.type})`).join(', ');

      const prompt = hasTeacherMemo
        ? `채움영어학원 선생님이 작성한 피드백을 아래 학생 성적 데이터를 반영하여 더 구체적이고 자연스럽게 다듬어 주세요. 기존 피드백의 핵심 내용과 톤을 유지하면서 오답 분석 내용을 자연스럽게 녹여주세요.

학생: ${studentName}
시험명: ${examId}
점수: ${totalScore}점 / 100점
오답 문항: ${incorrectSummary}
기존 선생님 피드백: ${teacherMemo}

[작성 규칙]
- 학부모에게 전달하는 따뜻하고 전문적인 어투
- 기존 피드백 내용을 바탕으로 오답 영역/유형을 자연스럽게 포함
- 마크다운 기호 없이 본문만`
        : `채움영어학원 선생님입니다. 아래 학생의 시험 결과를 바탕으로 학부모 전달용 피드백을 3~4문장으로 작성해 주세요.

학생: ${studentName}
시험명: ${examId}
점수: ${totalScore}점 / 100점
오답 문항: ${incorrectSummary}

[작성 규칙]
- 학부모에게 전달하는 따뜻하고 전문적인 어투
- 오답 문항의 영역/유형을 구체적으로 언급
- 잘한 점과 보완점 균형있게 서술
- 마크다운 기호 없이 본문만`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:500, messages:[{role:'user',content:prompt}] })
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
