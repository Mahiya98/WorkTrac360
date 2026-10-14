const { handleLoad } = require('../lib/db');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const url = new URL(req.url, 'http://localhost');
    const data = await handleLoad(url.searchParams);
    res.statusCode = 200;
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
};
