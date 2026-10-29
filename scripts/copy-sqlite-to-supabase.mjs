// One-time copy of the old local SQLite database (invoice.db) into Supabase Postgres.
// Run it BEFORE the first `npm start` on Supabase (otherwise the app seeds a demo organisation into the empty database).
// Keeps every id, so links between rows stay intact, then moves the id counters past the copied rows.
// The SQLite file is opened read-only and left untouched.
//   node scripts/copy-sqlite-to-supabase.mjs [path/to/invoice.db] [--force]
// --force: copy even if Supabase already has organisations (rows with the same id are skipped).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

try { process.loadEnvFile('.env'); } catch {}
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || 'invoice.db';
const force = args.includes('--force');
const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!url) { console.error('Set SUPABASE_DB_URL in .env first.'); process.exit(1); }
if (!fs.existsSync(file)) { console.error(`No SQLite file at ${file}`); process.exit(1); }

const lite = new DatabaseSync(file, { readOnly: true });
const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
await client.connect();

// parents before children
const ORDER = ['users', 'tenants', 'roles', 'memberships', 'sessions', 'settings', 'organisations', 'clients', 'service_products', 'invoices',
  'invoice_items', 'payments', 'message_templates', 'reminder_log', 'email_notify', 'recurring_invoices', 'credit_notes', 'expenses',
  'activity_log', 'tasks', 'task_assignees'];
const liteTables = new Set(lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
const pgCols = async (t) => (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', ['public', t])).rows.map((r) => r.column_name);

try {
  // create the tables if they aren't there yet (same schema the app uses)
  await client.query(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'schema.sql'), 'utf8'));
  const existing = (await client.query('SELECT COUNT(*)::int AS n FROM tenants')).rows[0].n;
  if (existing && !force) throw new Error(`Supabase already has ${existing} organisation(s). Nothing copied. Use --force to copy anyway (rows with the same id are skipped).`);

  await client.query('BEGIN');
  const roleOf = new Map(); // users.role_id is restored after roles exist
  for (const t of ORDER) {
    if (!liteTables.has(t)) continue;
    const target = new Set(await pgCols(t));
    const rows = lite.prepare(`SELECT * FROM "${t}"`).all();
    if (!rows.length) { console.log(`${t.padEnd(18)} 0`); continue; }
    const cols = Object.keys(rows[0]).filter((c) => target.has(c));
    let copied = 0;
    for (const r of rows) {
      if (t === 'users' && r.role_id != null) { roleOf.set(r.id, r.role_id); r.role_id = null; }
      const vals = cols.map((c) => r[c]);
      const res = await client.query(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`, vals);
      copied += res.rowCount;
    }
    console.log(`${t.padEnd(18)} ${copied} of ${rows.length}`);
  }
  for (const [uid, rid] of roleOf) await client.query('UPDATE users SET role_id = $1 WHERE id = $2 AND EXISTS (SELECT 1 FROM roles WHERE id = $1)', [rid, uid]);
  // next new row gets an id after the copied ones
  // (only tables with an id column: a failing query here would silently abort the whole transaction)
  for (const t of ORDER) {
    if (!(await pgCols(t)).includes('id')) continue;
    const seq = (await client.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [t])).rows[0]?.s;
    if (seq) await client.query(`SELECT setval($1, COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`, [seq]);
  }
  const done = await client.query('COMMIT');
  if (done.command !== 'COMMIT') throw new Error('the database rolled the copy back');
  console.log('\nDone. Your data is in Supabase.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nCopy failed, nothing was changed in Supabase:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
