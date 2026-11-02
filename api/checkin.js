// 🚪 출석 체크 (학원 입구 태블릿) + 학부모 알림톡
//  - 학생이 출석번호 4자리를 누르면: 오늘 첫 체크 = 등원, 두 번째 체크 = 하원
//  - 출결 기록(✅ 출결 기록 DB)에 등원시각·하원시각을 남기고, 기록이 없으면 상황에 맞는 상태로 만듦
//  - 알림톡은 이 파일 한 곳에서만 보냄. 보낸 시각을 '등원알림'/'하원알림' 칸에 남겨서 절대 두 번 안 보냄
//  - 선생님용 'notify': 관리 화면의 📲 버튼 → 지금 시각으로 기록 + 알림톡 (이미 보냈으면 안 보냄)
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const DB_SCHEDULE   = process.env.NOTION_DB_SCHEDULE;
  const DB_ATTENDANCE = process.env.NOTION_DB_ATTENDANCE;
  const SOL = {
    key:    process.env.SOLAPI_API_KEY,
    secret: process.env.SOLAPI_API_SECRET,
    pfId:   process.env.SOLAPI_PFID,          // 솔라피에 연동한 카카오 채널 pfId
    tplIn:  process.env.SOLAPI_TEMPLATE_IN,   // 등원 템플릿 ID
    tplOut: process.env.SOLAPI_TEMPLATE_OUT,  // 하원 템플릿 ID
    from:   process.env.SOLAPI_SENDER || '',  // 알림톡 실패 시 문자로 대신 보낼 발신번호 (선택)
  };
  const alimOn = !!(SOL.key && SOL.secret && SOL.pfId && SOL.tplIn);

  if (!NOTION_TOKEN || !DB_SCHEDULE || !DB_ATTENDANCE) {
    return res.status(500).json({ error: '환경변수를 확인해주세요.' });
  }
  const headers = {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };
  const nFetch = async (url, method = 'GET', body) => {
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json();
    if (d.object === 'error') throw new Error(d.message);
    return d;
  };
  const queryAll = async (dbId, filter) => {
    let all = [], cursor;
    do {
      const b = { page_size: 100 };
      if (filter) b.filter = filter;
      if (cursor) b.start_cursor = cursor;
      const d = await nFetch(`https://api.notion.com/v1/databases/${dbId}/query`, 'POST', b);
      all = all.concat(d.results || []);
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);
    return all;
  };
  const txt = p => (p?.rich_text || p?.title || []).map(t => t.plain_text ?? t.text?.content ?? '').join('').trim();
  const rt = v => ({ rich_text: v ? [{ text: { content: String(v) } }] : [] });

  // 한국 시간
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const today = kst.toISOString().slice(0, 10);
  const hhmm = kst.toISOString().slice(11, 16);
  const dayName = '일월화수목금토'[kst.getUTCDay()];
  // 수업 시작 시각 (학원 시간표): 중등 1부 3:30 / 2부 6:00, 고등 1부 6:00 / 2부 8:30
  const SLOT_START = { '중등': { '1부': '15:30', '2부': '18:00' }, '초등': { '1부': '15:30', '2부': '18:00' }, '고등': { '1부': '18:00', '2부': '20:30' } };
  // 수업 시작 후 90분이 지나서 그날 처음 누를 때만 "등원? 하원?"을 물어봄
  // (그 전에는 늦게 온 것으로 보고 항상 등원 처리 → 지각생에게 하원 알림이 갈 일이 없음)
  const LATE_MIN = 90;
  const toMin = t => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const shortName = n => String(n).replace(/\s*\(.*?\)\s*/g, '');

  // ── 솔라피 알림톡 ──
  const solAuth = () => {
    const date = new Date().toISOString();
    const salt = crypto.randomBytes(16).toString('hex');
    const signature = crypto.createHmac('sha256', SOL.secret).update(date + salt).digest('hex');
    return `HMAC-SHA256 apiKey=${SOL.key}, date=${date}, salt=${salt}, signature=${signature}`;
  };
  const phonesOf = s => String(s || '').split(/[,\/\s]+/).map(p => p.replace(/\D/g, '')).filter(p => /^01\d{8,9}$/.test(p));
  const sendAlim = async (phones, templateId, variables) => {
    if (!alimOn || !templateId || !phones.length) return { sent: 0, skipped: true };
    const messages = phones.map(to => ({
      to,
      ...(SOL.from ? { from: SOL.from.replace(/\D/g, '') } : {}),
      kakaoOptions: { pfId: SOL.pfId, templateId, variables, disableSms: !SOL.from },
    }));
    const r = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
      method: 'POST',
      headers: { 'Authorization': solAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.errorMessage || d.message || `알림톡 발송 실패 (${r.status})`);
    const failed = (d.failedMessageList || []).length;
    return { sent: phones.length - failed, failed, detail: failed ? d.failedMessageList : undefined };
  };

  // ── 학생 ──
  const toStudent = p => ({
    id: p.id,
    name: txt(p.properties['학생이름']),
    type: p.properties['구분']?.select?.name || '',
    grade: p.properties['학년']?.select?.name || '',
    pins: txt(p.properties['출석번호']).split(/[,\s]+/).map(x => x.replace(/\D/g, '')),
    phones: txt(p.properties['학부모연락처']),
    slot: p.properties[`수업부_${dayName}`]?.select?.name || p.properties['수업부']?.select?.name || '',
    school: txt(p.properties['학교']),
    regularToday: !!p.properties[dayName]?.checkbox,
    session: p.properties['수업형태']?.select?.name === '회차',
  });

  // 오늘 처음 기록을 만들 때 출결상태 정하기
  //  - 시험기간인 학교·학년 → 시험기간보강
  //  - 정규 요일이 아닌 날(주말 포함) 온 정규 학생 → 보강완료 (앱이 이번 달 결석과 자동으로 짝지어 줌)
  //  - 그 밖(정규 요일, 특목고 회차) → 출석
  const newStatus = async s => {
    const DB_EXAM = process.env.NOTION_DB_EXAM;
    if (DB_EXAM && s.school) {
      try {
        const ex = await queryAll(DB_EXAM, { and: [
          { property: '시험기간_시작', date: { on_or_before: today } },
          { property: '시험기간_종료', date: { on_or_after: today } },
        ]});
        const hit = ex.some(e => {
          const sc = (e.properties['학교명']?.title || []).map(t => t.plain_text || '').join('').trim();
          const gr = e.properties['학년']?.select?.name || '';
          return sc && (sc.includes(s.school) || s.school.includes(sc)) && (!gr || !s.grade || gr === s.grade);
        });
        if (hit) return '시험기간보강';
      } catch (e) { /* 시험정보를 못 읽으면 아래 규칙으로 */ }
    }
    if (!s.session && !s.regularToday) return '보강완료';
    return '출석';
  };

  const todayRec = async s => {
    const recs = await queryAll(DB_ATTENDANCE, { and: [
      { property: '학생이름', rich_text: { equals: s.name } },
      { property: '날짜', date: { on_or_after: today } },
      { property: '날짜', date: { on_or_before: today } },
      { property: '구분', select: { equals: s.type } },
    ]});
    return recs[0] || null;
  };

  // 기록 새로 만들기 → 만들어진 페이지 반환
  const createRec = async (s, extra) => {
    const st = await newStatus(s);
    const page = await nFetch('https://api.notion.com/v1/pages', 'POST', {
      parent: { database_id: DB_ATTENDANCE },
      properties: {
        '기록제목': { title: [{ text: { content: `${s.name} — ${st} (${today})` } }] },
        '날짜':     { date: { start: today } },
        '학생이름': rt(s.name),
        '구분':     { select: { name: s.type } },
        ...(s.grade ? { '학년': { select: { name: s.grade } } } : {}),
        '출결상태': { select: { name: st } },
        ...extra,
      }
    });
    return { page, status: st };
  };
  // 이미 있는 기록에 시각 넣기 (결석→출석, 오늘 잡아둔 보강→보강완료)
  const patchRec = async (s, rec, extra) => {
    const st = rec.properties['출결상태']?.select?.name || '';
    const to = st === '결석' ? '출석' : st === '보강' ? '보강완료' : '';
    await nFetch(`https://api.notion.com/v1/pages/${rec.id}`, 'PATCH', { properties: {
      ...extra,
      ...(to ? { '출결상태': { select: { name: to } }, '기록제목': { title: [{ text: { content: `${s.name} — ${to} (${today})` } }] } } : {}),
    }});
    return to || st;
  };

  // ⭐ 알림톡은 반드시 이 함수로만: 이미 보낸 기록이 있으면 안 보냄, 보냈으면 시각을 남김
  const notifyOnce = async (s, recId, recProps, kind) => {
    const field = kind === 'in' ? '등원알림' : '하원알림';
    const at = txt(recProps?.[field]);
    if (at) return { already: true, at };
    if (!alimOn) return { skipped: true, reason: '알림톡 설정 전' };
    const phones = phonesOf(s.phones);
    if (!phones.length) return { skipped: true, reason: '학부모 연락처 없음' };
    const tpl = kind === 'in' ? SOL.tplIn : SOL.tplOut;
    if (!tpl) return { skipped: true, reason: '하원 템플릿 설정 전' };
    try {
      const r = await sendAlim(phones, tpl, { '#{학생명}': shortName(s.name), '#{시각}': hhmm });
      if (r.sent > 0) {
        await nFetch(`https://api.notion.com/v1/pages/${recId}`, 'PATCH', { properties: { [field]: rt(hhmm) } });
      }
      return { ...r, at: r.sent > 0 ? hhmm : undefined };
    } catch (e) {
      return { error: e.message };
    }
  };

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action } = body;

  try {
    // ── 상태 (알림톡 연결됐는지) ──
    if (action === 'status') {
      return res.status(200).json({ ok: true, alimtalk: alimOn, today, now: hhmm });
    }

    // ── 알림톡 테스트: 원하는 번호로 등원 알림 한 통 ──
    if (action === 'test_alimtalk') {
      if (!alimOn) return res.status(400).json({ error: '알림톡 설정(솔라피 키·채널·템플릿)이 아직 없어요.' });
      const phones = phonesOf(body.phone);
      if (!phones.length) return res.status(400).json({ error: '전화번호를 확인해 주세요.' });
      const r = await sendAlim(phones, SOL.tplIn, { '#{학생명}': '테스트', '#{시각}': hhmm });
      return res.status(200).json({ ok: true, ...r });
    }

    // ── 선생님용: 📲 등원/하원 알림 (지금 시각으로 기록 + 알림톡, 중복 없음) ──
    if (action === 'notify') {
      const kind = body.kind === 'out' ? 'out' : 'in';
      if (!alimOn) return res.status(400).json({ error: '알림톡 설정(솔라피 키)이 아직 없어요.' });
      const rows = await queryAll(DB_SCHEDULE, { and: [
        { property: '학생이름', title: { equals: body.name || '' } },
        { property: '구분', select: { equals: body.type || '' } },
      ]});
      if (!rows.length) return res.status(404).json({ error: '학생을 찾지 못했어요.' });
      const s = toStudent(rows[0]);
      if (!phonesOf(s.phones).length) return res.status(400).json({ error: '학부모 연락처가 없어요. 학생 목록에서 넣어주세요.' });
      const field = kind === 'in' ? '등원시각' : '하원시각';
      let rec = await todayRec(s), recId, recProps = {}, time = hhmm, status;
      if (!rec) {
        const c = await createRec(s, { [field]: rt(hhmm) });
        recId = c.page.id; status = c.status;
      } else {
        recId = rec.id; recProps = rec.properties;
        const cur = txt(rec.properties[field]);
        if (cur) time = cur; // 이미 찍힌 시각은 그대로 둠
        else status = await patchRec(s, rec, { [field]: rt(hhmm) });
      }
      const alim = await notifyOnce(s, recId, recProps, kind);
      if (alim.error) return res.status(502).json({ error: '알림톡 발송 실패: ' + alim.error, time });
      return res.status(200).json({ ok: true, kind, name: s.name, time, status, alim });
    }

    // ── 출석 체크 (태블릿) ──
    if (action === 'checkin') {
      const pin = String(body.pin || '').replace(/\D/g, '');
      if (pin.length < 4) return res.status(400).json({ error: '번호 4자리를 눌러주세요.' });

      // 🧪 테스트 번호 0000: 출결 기록은 남기지 않고 등원·하원을 번갈아 보여줌
      //    (Vercel 환경변수 SOLAPI_TEST_PHONE이 있으면 그 번호로 알림톡도 실제로 보냄)
      if (pin === '0000') {
        const kind = body.testKind === 'out' ? 'out' : 'in';
        let alim = { skipped: true };
        try {
          alim = await sendAlim(phonesOf(process.env.SOLAPI_TEST_PHONE), kind === 'in' ? SOL.tplIn : (SOL.tplOut || ''),
            { '#{학생명}': '테스트', '#{시각}': hhmm });
        } catch (e) { alim = { error: e.message }; }
        return res.status(200).json({ ok: true, test: true, kind, name: '테스트', time: hhmm,
          message: `테스트 ${kind === 'in' ? '등원' : '하원'} ${hhmm}`, alim });
      }

      // 1. 번호로 학생 찾기
      const rows = await queryAll(DB_SCHEDULE, { property: '출석번호', rich_text: { contains: pin } });
      let cands = rows.map(toStudent).filter(s => s.name && s.pins.includes(pin));
      if (!cands.length) return res.status(404).json({ error: '등록되지 않은 번호예요. 선생님께 말씀해 주세요.' });
      if (body.pick) cands = cands.filter(s => s.name === body.pick);
      if (cands.length > 1) {
        return res.status(200).json({ ok: true, choose: cands.map(s => ({ name: s.name, type: s.type, grade: s.grade })) });
      }
      if (!cands.length) return res.status(404).json({ error: '학생을 찾지 못했어요.' });
      const s = cands[0];

      // 2. 오늘 출결 기록
      const rec = await todayRec(s);
      const inT  = rec ? txt(rec.properties['등원시각']) : '';
      const outT = rec ? txt(rec.properties['하원시각']) : '';
      const mode = body.mode === 'in' || body.mode === 'out' ? body.mode : '';

      if (outT) {
        return res.status(200).json({ ok: true, kind: 'done', name: s.name,
          message: inT ? `${s.name} 학생은 오늘 등원(${inT})·하원(${outT}) 모두 기록됐어요.` : `${s.name} 학생은 오늘 하원(${outT})까지 기록됐어요.` });
      }

      // 등원을 안 누르고 하원할 때 처음 누른 경우: 수업 시작 90분 뒤부터는 등원/하원을 물어봄
      const start = SLOT_START[s.type]?.[s.slot] || '';
      if (!inT && !mode && start && toMin(hhmm) - toMin(start) >= LATE_MIN) {
        return res.status(200).json({ ok: true, ask: true, name: s.name, time: hhmm, start });
      }

      let kind, recId, recProps = {}, status;
      if (!inT && mode === 'out') {
        // 등원 체크 없이 하원: 하원 시각만 남기고 메모에 표시
        const extra = { '하원시각': rt(hhmm), '메모': rt([rec ? txt(rec.properties['메모']) : '', '등원 체크 안 함'].filter(Boolean).join(' · ')) };
        if (!rec) { const c = await createRec(s, extra); recId = c.page.id; status = c.status; }
        else { recId = rec.id; recProps = rec.properties; status = await patchRec(s, rec, extra); }
        kind = 'out';
      } else if (!inT) {
        if (!rec) { const c = await createRec(s, { '등원시각': rt(hhmm) }); recId = c.page.id; status = c.status; }
        else { recId = rec.id; recProps = rec.properties; status = await patchRec(s, rec, { '등원시각': rt(hhmm) }); }
        kind = 'in';
      } else {
        const gap = toMin(hhmm) - toMin(inT);
        if (gap !== null && gap < 10) {
          return res.status(200).json({ ok: true, kind: 'dup', name: s.name, time: inT,
            message: `${s.name} 학생은 ${inT}에 이미 등원했어요. 하원할 때 다시 눌러주세요.` });
        }
        await nFetch(`https://api.notion.com/v1/pages/${rec.id}`, 'PATCH', { properties: { '하원시각': rt(hhmm) } });
        recId = rec.id; recProps = rec.properties;
        kind = 'out';
      }

      // 3. 알림톡 (중복 방지)
      const alim = await notifyOnce(s, recId, recProps, kind);
      const studyMin = kind === 'out' && inT ? toMin(hhmm) - toMin(inT) : null;
      return res.status(200).json({ ok: true, kind, name: s.name, time: hhmm, status, inTime: inT || undefined, studyMin,
        noIn: kind === 'out' && !inT ? true : undefined,
        message: kind === 'in' ? `${s.name} 학생 등원 ${hhmm}` : `${s.name} 학생 하원 ${hhmm}`, alim });
    }

    return res.status(400).json({ error: '알 수 없는 action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
