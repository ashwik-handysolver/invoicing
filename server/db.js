// Database: Supabase Postgres (connection string in SUPABASE_DB_URL).
// all / get / run / tx keep the shape the app was written against (SQLite style, `?` placeholders) and are async.
// Queries are translated to Postgres on the way through; see toPg().
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Missing SUPABASE_DB_URL: add your Supabase connection string to .env (Supabase → Connect → Session pooler).');
  process.exit(1);
}

// COUNT/SUM come back as int8 / numeric: return them as JS numbers like SQLite did
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => parseFloat(v));

export const pool = new pg.Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  max: +(process.env.DB_POOL_MAX || (process.env.VERCEL ? 3 : 10)), // serverless: many small instances, few connections each
  idleTimeoutMillis: 30000,
});
pool.on('error', (e) => console.error('db pool error', e.message));

// Tables without an `id` column: INSERTs into them don't get RETURNING id
const NO_ID = new Set(['settings', 'sessions', 'task_assignees']);
const cache = new Map();
// SQLite-flavoured SQL -> Postgres: ? -> $n, LIKE -> ILIKE (SQLite LIKE ignores case), COLLATE NOCASE -> lower(),
// INSERT OR IGNORE -> ON CONFLICT DO NOTHING, CURRENT_TIMESTAMP -> same text format as before, char() -> chr(),
// and INSERT ... RETURNING id so callers still get lastInsertRowid.
function toPg(sql) {
  let out = cache.get(sql);
  if (out) return out;
  let s = '', n = 0, q = null;
  for (const ch of sql) {
    if (q) { s += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; s += ch; continue; }
    s += ch === '?' ? `$${++n}` : ch;
  }
  s = s.replace(/(\b[\w.]+)\s*=\s*(\$\d+)\s+COLLATE\s+NOCASE/gi, 'lower($1) = lower($2)')
    .replace(/\s+COLLATE\s+NOCASE/gi, '')
    .replace(/\bNOT\s+LIKE\b/g, 'NOT ILIKE').replace(/(?<!NOT )\bLIKE\b/g, 'ILIKE')
    .replace(/\bCURRENT_TIMESTAMP\b/g, 'utc_now_text()')
    .replace(/\bchar\((\d+)\)/g, 'chr($1)');
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(s);
  if (ignore) s = s.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  const ins = s.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  if (ins && !NO_ID.has(ins[1].toLowerCase()) && !/\bRETURNING\b/i.test(s)) s += ' RETURNING id';
  out = s;
  cache.set(sql, out);
  return out;
}

const clean = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? +x : x));
const txStore = new AsyncLocalStorage(); // the client of the transaction we are inside, if any
async function query(sql, p) {
  await ready; // tables exist before the first query (some modules read settings while loading)
  const c = txStore.getStore() || pool;
  try { return await c.query(toPg(sql), clean(p)); }
  catch (e) {
    // keep the error text the app already maps ("UNIQUE constraint", "FOREIGN KEY constraint")
    if (e.code === '23505') e.message = 'UNIQUE constraint failed: ' + e.message;
    else if (e.code === '23503') e.message = 'FOREIGN KEY constraint failed: ' + e.message;
    else if (e.code === '23514' || e.code === '23502') e.message = 'CHECK constraint failed: ' + e.message;
    throw e;
  }
}
export const all = async (sql, ...p) => (await query(sql, p)).rows;
export const get = async (sql, ...p) => (await query(sql, p)).rows[0];
export const run = async (sql, ...p) => { const r = await query(sql, p); return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id }; };
// Nested tx() calls join the outer transaction
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await txStore.run(client, fn);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// Create / update tables (idempotent), then the app's install-wide settings
const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'schema.sql'), 'utf8');
export const ready = pool.query(schema).catch((e) => { console.error('Could not prepare the database:', e.message); process.exit(1); });

// tenant 0 holds install-wide flags
export const getSetting = async (k, dflt, tid = 0) => { const r = await get('SELECT value FROM settings WHERE tenant_id = ? AND key = ?', tid, k); return r ? JSON.parse(r.value) : dflt; };
export const setSetting = (k, v, tid = 0) => run('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value', tid, k, JSON.stringify(v));

/* ---- organisation invite codes ---- */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const normCode = (c) => {
  const x = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x.length === 10 ? `${x.slice(0, 5)}-${x.slice(5)}` : null;
};
export async function newInviteCode() {
  for (;;) {
    const code = normCode(Array.from({ length: 10 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''));
    if (!(await get('SELECT 1 AS x FROM tenants WHERE invite_code = ?', code))) return code;
  }
}
