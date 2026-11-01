// 🚪 출석 체크 (학원 입구 태블릿) + 학부모 알림톡
//  - 학생이 출석번호 4자리를 누르면: 오늘 첫 체크 = 등원, 두 번째 체크 = 하원
//  - 출결 기록(✅ 출결 기록 DB)에 등원시각·하원시각을 남기고, 기록이 없으면 '출석'으로 만듦
//  - 솔라피 키가 환경변수에 있으면 학부모연락처로 알림톡 발송 (없으면 기록만)
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

  // 한국 시간
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const today = kst.toISOString().slice(0, 10);
  const hhmm = kst.toISOString().slice(11, 16);
  const toMin = t => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };

  // 솔라피 알림톡
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

    // ── 출석 체크 ──
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
      let cands = rows.map(p => ({
        id: p.id,
        name: txt(p.properties['학생이름']),
        type: p.properties['구분']?.select?.name || '',
        grade: p.properties['학년']?.select?.name || '',
        pins: txt(p.properties['출석번호']).split(/[,\s]+/).map(x => x.replace(/\D/g, '')),
        phones: txt(p.properties['학부모연락처']),
      })).filter(s => s.name && s.pins.includes(pin));
      if (!cands.length) return res.status(404).json({ error: '등록되지 않은 번호예요. 선생님께 말씀해 주세요.' });
      if (body.pick) cands = cands.filter(s => s.name === body.pick);
      if (cands.length > 1) {
        return res.status(200).json({ ok: true, choose: cands.map(s => ({ name: s.name, type: s.type, grade: s.grade })) });
      }
      if (!cands.length) return res.status(404).json({ error: '학생을 찾지 못했어요.' });
      const s = cands[0];

      // 2. 오늘 출결 기록
      const recs = await queryAll(DB_ATTENDANCE, { and: [
        { property: '학생이름', rich_text: { equals: s.name } },
        { property: '날짜', date: { on_or_after: today } },
        { property: '날짜', date: { on_or_before: today } },
        { property: '구분', select: { equals: s.type } },
      ]});
      const rec = recs[0];
      const inT  = rec ? txt(rec.properties['등원시각']) : '';
      const outT = rec ? txt(rec.properties['하원시각']) : '';

      let kind, msg;
      if (!rec) {
        await nFetch('https://api.notion.com/v1/pages', 'POST', {
          parent: { database_id: DB_ATTENDANCE },
          properties: {
            '기록제목': { title: [{ text: { content: `${s.name} — 출석 (${today})` } }] },
            '날짜':     { date: { start: today } },
            '학생이름': { rich_text: [{ text: { content: s.name } }] },
            '구분':     { select: { name: s.type } },
            ...(s.grade ? { '학년': { select: { name: s.grade } } } : {}),
            '출결상태': { select: { name: '출석' } },
            '등원시각': { rich_text: [{ text: { content: hhmm } }] },
          }
        });
        kind = 'in';
      } else if (!inT) {
        // 미리 결석으로 표시돼 있었는데 왔으면 출석으로 바꿈 (보강 등 다른 상태는 그대로)
        const st = rec.properties['출결상태']?.select?.name || '';
        await nFetch(`https://api.notion.com/v1/pages/${rec.id}`, 'PATCH', { properties: {
          '등원시각': { rich_text: [{ text: { content: hhmm } }] },
          ...(st === '결석' ? { '출결상태': { select: { name: '출석' } }, '기록제목': { title: [{ text: { content: `${s.name} — 출석 (${today})` } }] } } : {}),
        }});
        kind = 'in';
      } else if (!outT) {
        const gap = toMin(hhmm) - toMin(inT);
        if (gap !== null && gap < 10) {
          return res.status(200).json({ ok: true, kind: 'dup', name: s.name, time: inT,
            message: `${s.name} 학생은 ${inT}에 이미 등원했어요. 하원할 때 다시 눌러주세요.` });
        }
        await nFetch(`https://api.notion.com/v1/pages/${rec.id}`, 'PATCH', { properties: {
          '하원시각': { rich_text: [{ text: { content: hhmm } }] },
        }});
        kind = 'out';
      } else {
        return res.status(200).json({ ok: true, kind: 'done', name: s.name,
          message: `${s.name} 학생은 오늘 등원(${inT})·하원(${outT}) 모두 기록됐어요.` });
      }

      // 3. 알림톡
      let alim = { skipped: true };
      try {
        alim = await sendAlim(phonesOf(s.phones), kind === 'in' ? SOL.tplIn : (SOL.tplOut || ''),
          { '#{학생명}': s.name.replace(/\s*\(.*?\)\s*/g, ''), '#{시각}': hhmm });
      } catch (e) {
        alim = { error: e.message };
      }
      return res.status(200).json({ ok: true, kind, name: s.name, time: hhmm,
        message: kind === 'in' ? `${s.name} 학생 등원 ${hhmm}` : `${s.name} 학생 하원 ${hhmm}`, alim });
    }

    return res.status(400).json({ error: '알 수 없는 action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
