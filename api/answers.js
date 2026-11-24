// 📘 교사용 정답지 API
//  - 정답 데이터는 서버(이 파일 옆 _answers-data.js)에만 있고, 비밀번호가 맞아야 내려보냄
//  - 비밀번호: Vercel 환경변수 ANSWERS_PIN (없으면 출석 화면 선생님 비밀번호와 같은 기본값)
import DATA from './_answers-data.js';

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
  return res.status(200).json(DATA);
}
