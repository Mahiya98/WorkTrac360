const { Pool } = require('pg');
const pg = require('pg');
pg.types.setTypeParser(1082, v => v); // DATE -> string

const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: { rejectUnauthorized: false },
  max: 3,
});
pool.on('error', () => {});

const SCHEMA = 'ACCL';
function q(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }
const eIso = n => n ? new Date(+n).toISOString() : null;

const TABLES = {
  users: { pk: 'id', noUpdate: new Set(['created_at']), cols: ['id','enroll','name','section','role','type','status','created_at','updated_at','is_deleted'], json: new Set() },
  roles: { pk: 'id', cols: ['id','section','name'], json: new Set() },
  dict: { pk: 'id', cols: ['id','section','role','title','est_min','priority','frequency'], json: new Set() },
  tasks: { pk: 'id', cols: ['id','code','title','description','section','role','assignee_id','supervisor_id','est_min','actual_min','priority','shift','due_date','frequency','status','created_at','updated_at','timer_start','attachments','comments','is_cross','assigned_by_id','assigned_by_name','from_section'], json: new Set(['attachments','comments']) },
  notify: { pk: 'id', cols: ['id','at','to_user','title','body','is_read'], json: new Set() },
  settings: { pk: 'key', cols: ['key','value'], json: new Set(['value']) },
  seq: { pk: 'key', cols: ['key','value'], json: new Set() },
};
const PREFIX = { u: 'users', r: 'roles', d: 'dict', t: 'tasks', n: 'notify' };

function toUsers(list) {
  const now = new Date().toISOString();
  return (list || []).map(u => ({ id: u.id, enroll: u.enroll == null ? null : String(u.enroll), name: u.name || '', section: u.section || null, role: u.role || null, type: u.type || 'member', status: u.status || 'pending', created_at: now, updated_at: now, is_deleted: false }));
}
function toRoles(list) { return (list || []).map(r => ({ id: r.id, section: r.section || null, name: r.name || null })); }
function toDict(list) { return (list || []).map(d => ({ id: d.id, section: d.section || null, role: d.role || null, title: d.title || null, est_min: +d.estMin || 0, priority: d.priority || null, frequency: d.frequency || null })); }
function toTasks(list) {
  return (list || []).map(t => ({ id: t.id, code: t.code || null, title: t.title || '', description: t.desc || null, section: t.section || null, role: t.role || null, assignee_id: t.assigneeId || null, supervisor_id: t.supervisorId || null, est_min: +t.estMin || 0, actual_min: +t.actualMin || 0, priority: t.priority || null, shift: t.shift || null, due_date: t.dueDate || null, frequency: t.frequency || null, status: t.status || 'Not Started', created_at: eIso(t.createdAt) || new Date().toISOString(), updated_at: eIso(t.updatedAt) || new Date().toISOString(), timer_start: t.timerStart || null, attachments: t.attachments || [], comments: t.comments || [], is_cross: !!t.cross, assigned_by_id: t.assignedById || null, assigned_by_name: t.assignedByName || null, from_section: t.fromSection || null }));
}
function toNotify(list) { return (list || []).map(n => ({ id: n.id, at: eIso(n.at) || new Date().toISOString(), to_user: n.to || null, title: n.title || null, body: n.body || null, is_read: !!n.read })); }

function dedupe(table, rows) { const pk = TABLES[table].pk; const m = new Map(); (rows || []).forEach(r => { if (r && r[pk] != null) m.set(String(r[pk]), r); }); return [...m.values()]; }

async function upsert(client, table, rows) {
  rows = dedupe(table, rows);
  if (!rows.length) return;
  const def = TABLES[table], cols = def.cols, pk = def.pk, json = def.json, noUp = def.noUpdate || new Set();
  const updCols = cols.filter(c => c !== pk && !noUp.has(c));
  const CH = 300;
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH);
    const params = [];
    const tuples = chunk.map(row => '(' + cols.map(c => { let v = row[c]; if (json.has(c)) v = JSON.stringify(v == null ? null : v); params.push(v); return json.has(c) ? ('$' + params.length + '::jsonb') : ('$' + params.length); }).join(',') + ')');
    const sql = 'INSERT INTO ' + q(SCHEMA) + '.' + q(table) + ' (' + cols.map(q).join(',') + ') VALUES ' + tuples.join(',') + ' ON CONFLICT (' + q(pk) + ') DO UPDATE SET ' + updCols.map(c => q(c) + '=EXCLUDED.' + q(c)).join(', ');
    await client.query(sql, params);
  }
}

async function handleSync(body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsert(client, 'users', toUsers(body.users));
    await upsert(client, 'roles', toRoles(body.roles));
    await upsert(client, 'dict', toDict(body.dict));
    await upsert(client, 'tasks', toTasks(body.tasks));
    await upsert(client, 'notify', toNotify(body.notify));
    if (body.settings) await upsert(client, 'settings', [{ key: 'dailyMinutes', value: +body.settings.dailyMinutes || 480 }]);
    const seqRows = Object.keys(body.seq || {}).map(k => ({ key: k, value: +body.seq[k] || 0 })).filter(x => x.key);
    if (seqRows.length) await upsert(client, 'seq', seqRows);
    const byTbl = {};
    (body.tomb || []).forEach(x => { const tb = PREFIX[String(x.id)[0]]; if (tb) (byTbl[tb] = byTbl[tb] || []).push(String(x.id)); });
    for (const tb of Object.keys(byTbl)) await client.query('DELETE FROM ' + q(SCHEMA) + '.' + q(tb) + ' WHERE ' + q(TABLES[tb].pk) + ' = ANY($1::text[])', [byTbl[tb]]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function handleLoad(params) {
  const userId = params.get('userId') || '';
  const type = params.get('type') || 'member';
  const section = params.get('section') || '';
  const since = parseInt(params.get('since') || '0', 10) || 0;
  const c = await pool.connect();
  try {
    const users = (await c.query('SELECT id,enroll,name,section,role,type,status,created_at,updated_at,is_deleted FROM ' + q(SCHEMA) + '.users WHERE is_deleted IS NOT TRUE')).rows;
    const roles = (await c.query('SELECT id,section,name FROM ' + q(SCHEMA) + '.roles')).rows;
    const dict = (await c.query('SELECT id,section,role,title,est_min,priority,frequency FROM ' + q(SCHEMA) + '.dict')).rows;
    const settings = (await c.query('SELECT key,value FROM ' + q(SCHEMA) + '.settings')).rows;
    const seq = (await c.query('SELECT key,value FROM ' + q(SCHEMA) + '.seq')).rows;
    let tasks = [], notify = [];
    if (userId) {
      const where = [], vals = [];
      if (type === 'supervisor') { where.push('(section=$' + (vals.length + 1) + ' OR assigned_by_id=$' + (vals.length + 2) + ' OR assignee_id=$' + (vals.length + 2) + ')'); vals.push(section, userId); }
      else if (type !== 'superadmin') { where.push('(assignee_id=$' + (vals.length + 1) + ' OR assigned_by_id=$' + (vals.length + 1) + ')'); vals.push(userId); }
      if (since > 0) { where.push('updated_at > to_timestamp($' + (vals.length + 1) + '/1000.0)'); vals.push(since); }
      tasks = (await c.query('SELECT * FROM ' + q(SCHEMA) + '.tasks' + (where.length ? ' WHERE ' + where.join(' AND ') : ''), vals)).rows;
      const nw = ['to_user=$1'], nv = [userId];
      if (since > 0) { nw.push('at > to_timestamp($2/1000.0)'); nv.push(since); }
      notify = (await c.query('SELECT id,at,to_user,title,body,is_read FROM ' + q(SCHEMA) + '.notify WHERE ' + nw.join(' AND ') + ' ORDER BY at DESC LIMIT 300', nv)).rows;
    }
    return { users, roles, dict, settings, seq, tasks, notify, now: Date.now() };
  } finally { c.release(); }
}

module.exports = { handleLoad, handleSync };
