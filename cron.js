// /api/cron — runs once a day (see vercel.json), warms the roster-wide visa
// and skill data, and writes it to Upstash Redis so every browser reads an
// already-warm cache instead of each doing its own 351-trainer scan.
//
// This is the server-side equivalent of what the dashboard's own
// awakenMangekyo() does client-side — moved here so it happens once, shared
// across every device, on a schedule, instead of once per browser per day.

const KOENIG_BASE = 'https://api.koenig-solutions.com/api/Kites/Operator/common';
const TRAINERLIST_URL = 'https://api.koenig-solutions.com/api/Kites/Operator/TrainerList';
const CONCURRENCY = 16; // polite default; raise if your endpoint tolerates more

async function koenig(apikey, body, AT, DT) {
  const url = `${KOENIG_BASE}?apikey=${apikey}&accessToken=${encodeURIComponent(AT)}&deviceToken=${encodeURIComponent(DT)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  // Every Koenig response double-wraps: {statuscode, content: "<json string>"}
  if (j && typeof j.content === 'string') {
    try { return JSON.parse(j.content); } catch { return []; }
  }
  return j && j.content ? j.content : [];
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function redisSet(key, value, base, token) {
  await fetch(`${base}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

export default async function handler(req, res) {
  // Vercel Cron calls this with a special header; also allow a manual
  // trigger with a shared secret so you can re-run it on demand.
  const isCron = req.headers['x-vercel-cron'] !== undefined;
  const manual = req.query.secret && req.query.secret === process.env.CRON_MANUAL_SECRET;
  if (!isCron && !manual) return res.status(401).json({ error: 'unauthorized' });

  const AT = process.env.KOENIG_ACCESS_TOKEN;
  const DT = process.env.KOENIG_DEVICE_TOKEN;
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!AT || !DT || !REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Missing required env vars' });
  }

  const t0 = Date.now();

  // 1. Roster: TrainerList gives every trainer + email in one call.
  const tlUrl = `${TRAINERLIST_URL}?accessToken=${encodeURIComponent(AT)}&deviceToken=${encodeURIComponent(DT)}`;
  const tlResp = await fetch(tlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const tlJson = await tlResp.json();
  const roster = (tlJson.content || [])
    .map(r => ({ name: r.TrainerName, email: r.EmailId }))
    .filter(t => t.email);

  const emails = [...new Set(roster.map(t => t.email))];

  // 2. Visas — one object per trainer.
  const visaCache = {};
  await pool(emails, CONCURRENCY, async (email) => {
    const rows = await koenig('109', { email_Address: email }, AT, DT);
    visaCache[email] = rows || [];
  });

  // 3. Skills — build the course -> [{name,email}] index directly, same
  //    shape the dashboard's own buildSkillIndex produces, so the browser
  //    can drop it straight into _skillIndex with no reshaping.
  const skillIndex = {};
  const byEmail = Object.fromEntries(roster.map(t => [t.email, t.name]));
  await pool(emails, CONCURRENCY, async (email) => {
    const rows = await koenig('75', { email }, AT, DT);
    (rows || []).forEach(r => {
      const cn = (r.CourseName || '').trim();
      if (!cn) return;
      if (!skillIndex[cn]) skillIndex[cn] = [];
      if (!skillIndex[cn].some(x => x.email === email)) {
        skillIndex[cn].push({ name: byEmail[email] || email, email, deliveries: r['Course Assignment'] || '' });
      }
    });
  });

  const payload = { t: Date.now(), rosterCount: emails.length };
  await redisSet('horizon:visas', { t: payload.t, d: visaCache }, REDIS_URL, REDIS_TOKEN);
  await redisSet('horizon:skills', { t: payload.t, d: skillIndex }, REDIS_URL, REDIS_TOKEN);
  await redisSet('horizon:meta', payload, REDIS_URL, REDIS_TOKEN);

  return res.status(200).json({
    ok: true,
    trainers: emails.length,
    courses: Object.keys(skillIndex).length,
    ms: Date.now() - t0,
  });
}
