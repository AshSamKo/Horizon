// /api/cache — the browser calls this once, on load, instead of running
// awakenMangekyo() itself. Returns whatever the last cron run wrote.
// If cron hasn't run yet (fresh deploy), returns empty objects and the
// dashboard's existing client-side awakening still works as a fallback.

async function redisGet(key, base, token) {
  const r = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  if (!j || j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(200).json({ visas: null, skills: null, meta: null });
  }

  const [visas, skills, meta] = await Promise.all([
    redisGet('horizon:visas', REDIS_URL, REDIS_TOKEN),
    redisGet('horizon:skills', REDIS_URL, REDIS_TOKEN),
    redisGet('horizon:meta', REDIS_URL, REDIS_TOKEN),
  ]);

  res.setHeader('Cache-Control', 'no-store'); // always read the latest cron write
  return res.status(200).json({ visas, skills, meta });
}
