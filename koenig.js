// /api/koenig — generic proxy to the Koenig Kites API.
//
// The browser calls THIS endpoint instead of api.koenig-solutions.com
// directly. AT/DT never leave the server, so they can no longer be read
// via view-source once this is deployed.
//
// Usage from the dashboard:
//   fetch('/api/koenig?apikey=109', { method:'POST', body: JSON.stringify({email_Address: '...'}) })
//
// Only apikeys this dashboard actually uses are allow-listed below — add
// more here if you wire in a new endpoint, rather than opening this up to
// arbitrary apikey values.

const ALLOWED_APIKEYS = new Set([
  '55', '75', '82', '108', '109', '111', '164', '233', '234',
]);

const KOENIG_BASE = 'https://api.koenig-solutions.com/api/Kites/Operator/common';
const TRAINERLIST_URL = 'https://api.koenig-solutions.com/api/Kites/Operator/TrainerList';

export default async function handler(req, res) {
  // Basic CORS so this can be called from the deployed page (same-origin in
  // practice, but harmless to allow and useful if you ever open it from
  // localhost during development).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const AT = process.env.KOENIG_ACCESS_TOKEN;
  const DT = process.env.KOENIG_DEVICE_TOKEN;
  if (!AT || !DT) {
    return res.status(500).json({ error: 'Server missing KOENIG_ACCESS_TOKEN / KOENIG_DEVICE_TOKEN env vars' });
  }

  const { apikey, trainerlist } = req.query;

  let url;
  if (trainerlist === '1') {
    url = `${TRAINERLIST_URL}?accessToken=${encodeURIComponent(AT)}&deviceToken=${encodeURIComponent(DT)}`;
  } else {
    if (!apikey || !ALLOWED_APIKEYS.has(String(apikey))) {
      return res.status(400).json({ error: 'Unknown or missing apikey' });
    }
    url = `${KOENIG_BASE}?apikey=${apikey}&accessToken=${encodeURIComponent(AT)}&deviceToken=${encodeURIComponent(DT)}`;
  }

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream fetch failed', detail: String(e) });
  }
}
