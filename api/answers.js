// 📘 교사용 정답지 API
//  - 정답·해설 데이터는 서버(_answers-data.js)에만 있고, 비밀번호가 맞아야 내려보냄
//  - { pin }            → 정답지 목록(학교·학년·제목·문항 수)
//  - { pin, id }        → 그 정답지의 정답 + 상세해설 전체
//  - 비밀번호: Vercel 환경변수 ANSWERS_PIN (없으면 출석 화면 선생님 비밀번호와 같은 기본값)
import DATA from './_answers-data.js';

const INDEX = DATA.sets.map(s => ({
  id: s.id, school: s.school, grade: s.grade, exam: s.exam, title: s.title, kind: s.kind || '실전문제',
  range: s.range || '', secs: s.sections.length, n: s.sections.reduce((a, x) => a + x.items.length, 0),
  hasExp: s.sections.some(x => x.items.some(it => it.e && it.e.length)),
}));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const PIN = process.env.ANSWERS_PIN || '7773';
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || String(body.pin || '') !== PIN) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ error: '비밀번호가 달라요' });
  }
  if (body.id) {
    const s = DATA.sets.find(x => x.id === body.id);
    if (!s) return res.status(404).json({ error: '정답지를 찾을 수 없어요' });
    return res.status(200).json(s);
  }
  return res.status(200).json({ updated: DATA.updated, sets: INDEX });
}
