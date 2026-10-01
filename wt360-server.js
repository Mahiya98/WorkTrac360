const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Client } = require('pg');

try { process.loadEnvFile && process.loadEnvFile(); } catch (e) { /* no .env */ }

const PORT = +(process.env.PORT || 3220);
const HOST = process.env.HOST || '0.0.0.0';

function dbConfig() {
  return {
    host: process.env.PGHOST || 'arl-community-developer.postgres.database.azure.com',
    user: process.env.PGUSER || 'deputy.coo@akijresource.com',
    port: +(process.env.PGPORT || 5432),
    database: process.env.WT360_DATABASE || process.env.PGDATABASE || 'ArlOpexDB',
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  };
}

async function load() {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const r = await client.query(
      'SELECT db, rev, ts, updated_at FROM wt360_state WHERE id = 1;'
    );
    if (r.rows.length === 0) {
      return { ok: false, error: 'wt360_state row (id=1) not found' };
    }
    const row = r.rows[0];
    return {
      ok: true,
      db: row.db,
      rev: row.rev,
      ts: row.ts,
      updatedAt: row.updated_at,
    };
  } finally {
    await client.end();
  }
}

async function save(db, baseRev) {
  const client = new Client(dbConfig());
  await client.connect();
  try {
    const r = await client.query(
      `UPDATE wt360_state
         SET db = $1::jsonb,
             rev = COALESCE(rev, 0) + 1,
             ts = $2,
             updated_at = now()
       WHERE id = 1 AND COALESCE(rev, 0) = $3
       RETURNING db, rev, ts, updated_at;`,
      [JSON.stringify(db), Date.now(), +baseRev || 0]
    );
    if (r.rows.length === 0) {
      const chk = await client.query('SELECT rev FROM wt360_state WHERE id = 1;');
      if (chk.rows.length === 0) {
        return { ok: false, error: 'wt360_state row (id=1) not found' };
      }
      return { ok: false, error: 'conflict', rev: chk.rows[0].rev };
    }
    const row = r.rows[0];
    return { ok: true, db: row.db, rev: row.rev, ts: row.ts, updatedAt: row.updated_at };
  } finally {
    await client.end();
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        let buf = Buffer.concat(chunks);
        const enc = String(req.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') {
          try { buf = zlib.gunzipSync(buf); } catch (e) { /* already decompressed upstream */ }
        } else if (enc === 'deflate') {
          try { buf = zlib.inflateSync(buf); } catch (e) { /* already decompressed upstream */ }
        }
        resolve(buf.toString('utf8'));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, pathname) {
  let rel = pathname === '/' || pathname === '/wt360' ? '/index.html' : pathname;
  rel = rel.split('?')[0];
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (pathname === '/api/wt360' || pathname === '/api/wt360/') {
    if (req.method === 'GET') {
      try {
        send(res, 200, await load());
      } catch (e) {
        send(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        send(res, 413, { ok: false, error: e.message });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        send(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }

      const action = parsed.action || (parsed.db ? 'save' : 'load');

      try {
        if (action === 'ping') {
          send(res, 200, { ok: true, pong: true, time: Date.now() });
        } else if (action === 'rev') {
          const client = new Client(dbConfig());
          await client.connect();
          try {
            const r = await client.query('SELECT rev, ts FROM wt360_state WHERE id = 1;');
            const row = r.rows[0];
            send(res, 200, { ok: true, rev: row ? row.rev : 0, ts: row ? row.ts : 0 });
          } catch (e) {
            send(res, 500, { ok: false, error: e.message });
          } finally {
            await client.end();
          }
        } else if (action === 'load') {
          send(res, 200, await load());
        } else if (action === 'save') {
          if (!parsed.db || typeof parsed.db !== 'object') {
            send(res, 400, { ok: false, error: 'missing db object' });
            return;
          }
            send(res, 200, await save(parsed.db, parsed.baseRev));
        } else {
          send(res, 400, { ok: false, error: 'unknown action: ' + action });
        }
      } catch (e) {
        send(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    send(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`WorkTrac360 server running at http://localhost:${PORT}`);
  console.log(`Backend: ${dbConfig().database} @ ${dbConfig().host}`);
});
