const { Client } = require('pg');
const zlib = require('zlib');

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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
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

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    res.end();
    return;
  }

  if (req.method === 'GET') {
    try {
      json(res, 200, await load());
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      json(res, 413, { ok: false, error: e.message });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch (e) {
      json(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }

    const action = parsed.action || (parsed.db ? 'save' : 'load');

    try {
      if (action === 'ping') {
        json(res, 200, { ok: true, pong: true, time: Date.now() });
      } else if (action === 'rev') {
        const client = new Client(dbConfig());
        await client.connect();
        try {
          const r = await client.query('SELECT rev, ts FROM wt360_state WHERE id = 1;');
          const row = r.rows[0];
          json(res, 200, { ok: true, rev: row ? row.rev : 0, ts: row ? row.ts : 0 });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        } finally {
          await client.end();
        }
      } else if (action === 'load') {
        json(res, 200, await load());
      } else if (action === 'save') {
        if (!parsed.db || typeof parsed.db !== 'object') {
          json(res, 400, { ok: false, error: 'missing db object' });
          return;
        }
        json(res, 200, await save(parsed.db, parsed.baseRev));
      } else {
        json(res, 400, { ok: false, error: 'unknown action: ' + action });
      }
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  json(res, 405, { ok: false, error: 'method not allowed' });
};
