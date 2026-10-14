const { handleSync } = require('../lib/db');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'method not allowed' })); }
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};
    await handleSync(body);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
};
