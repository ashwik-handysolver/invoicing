import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const file = process.env.DB_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'invoice.db');
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const clean = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? +x : x));
export const all = (sql, ...p) => db.prepare(sql).all(...clean(p));
export const get = (sql, ...p) => db.prepare(sql).get(...clean(p));
export const run = (sql, ...p) => db.prepare(sql).run(...clean(p));
let txDepth = 0; // nested tx() calls join the outer transaction
export function tx(fn) {
  if (txDepth) return fn();
  db.exec('BEGIN');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { txDepth--; }
}

const cols = (t) => all(`PRAGMA table_info(${t})`).map((x) => x.name);
const legacy = cols('roles').length > 0 && !cols('roles').includes('tenant_id'); // single-company DB from before organisation signup

// Tenant = the organisation people sign up for / join. Its billing entities (GSTIN, bank…) live in `organisations`.
const ROLES_SQL = `CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  UNIQUE (tenant_id, name)
)`;
// role_id stays NULL until the user is an approved member of an organisation
const USERS_SQL = `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`;
const SETTINGS_SQL = 'CREATE TABLE IF NOT EXISTS settings (tenant_id INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, value TEXT, PRIMARY KEY (tenant_id, key))';

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT, decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, user_id)
);
-- a user belongs to (or is waiting for) at most one organisation at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_active ON memberships(user_id) WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS idx_member_tenant ON memberships(tenant_id, status);
${ROLES_SQL};
${USERS_SQL};
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS organisations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT, state TEXT, state_code TEXT,
  gst_number TEXT, pan_number TEXT, email TEXT, contact TEXT,
  bank_details TEXT
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL,
  address TEXT, state TEXT, state_code TEXT,
  gst_number TEXT, pan_number TEXT, email TEXT, mobile TEXT,
  contact_person TEXT
);
CREATE TABLE IF NOT EXISTS service_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sac_number TEXT, description TEXT,
  price REAL DEFAULT 0, tax REAL DEFAULT 18
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('proforma','tax')),
  invoice_number TEXT NOT NULL,
  invoice_series_int INTEGER NOT NULL,
  fy TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  org_name TEXT, org_address TEXT, org_email TEXT, org_contact TEXT, org_gst TEXT, org_bank TEXT,
  client_name TEXT, client_address TEXT, client_email TEXT, client_contact TEXT, client_gst TEXT,
  place_of_supply TEXT,
  gross_amount REAL DEFAULT 0, discount_amount REAL DEFAULT 0, selling_amount REAL DEFAULT 0,
  igst REAL DEFAULT 0, cgst REAL DEFAULT 0, sgst REAL DEFAULT 0,
  tds_percent REAL DEFAULT 0, tds_amount REAL DEFAULT 0,
  total_amount REAL DEFAULT 0, net_amount REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0, balance_amount REAL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  converted_to_id INTEGER, converted_from_id INTEGER,
  notes TEXT,
  UNIQUE (organisation_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_inv_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_inv_date ON invoices(invoice_date);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_product_id INTEGER,
  position INTEGER,
  sac_number TEXT, description TEXT,
  price REAL, quantity REAL,
  gross_amount REAL, discount_percent REAL, discount_amount REAL, selling_amount REAL,
  tax REAL, igst REAL, cgst REAL, sgst REAL, total_amount REAL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT NOT NULL,
  mode TEXT, reference TEXT, notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  kind TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder','invoice','receipt')),
  subject TEXT,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER, invoice_id INTEGER,
  channel TEXT, template_id INTEGER, sent_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_notify (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL
);
`);

for (const col of ['logo', 'signature', 'footer_note', 'terms', 'upi_id']) {
  if (!all('PRAGMA table_info(organisations)').some((x) => x.name === col)) db.exec(`ALTER TABLE organisations ADD COLUMN ${col} TEXT`);
}

/* ---- v2 migrations ---- */
const addCol = (t, c, def) => { if (!all(`PRAGMA table_info(${t})`).some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('invoices', 'credit_amount', 'REAL DEFAULT 0');
addCol('invoices', 'share_token', 'TEXT');
addCol('invoices', 'viewed_at', 'TEXT');
addCol('invoices', 'view_count', 'INTEGER DEFAULT 0');
addCol('reminder_log', 'rule', 'INTEGER');

// message_templates.kind gains 'receipt' (SQLite can't alter a CHECK, so rebuild the table once)
if (!get("SELECT sql FROM sqlite_master WHERE name = 'message_templates'").sql.includes('receipt')) {
  db.exec(`ALTER TABLE message_templates RENAME TO mt_old;
    CREATE TABLE message_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
      kind TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder','invoice','receipt')), subject TEXT, body TEXT NOT NULL);
    INSERT INTO message_templates (id, name, channel, kind, subject, body) SELECT id, name, channel, kind, subject, body FROM mt_old;
    DROP TABLE mt_old;`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, created_by INTEGER,
  organisation_id INTEGER NOT NULL, client_id INTEGER NOT NULL,
  invoice_type TEXT NOT NULL DEFAULT 'tax',
  frequency TEXT NOT NULL, start_date TEXT NOT NULL, next_run TEXT NOT NULL, end_date TEXT,
  due_days INTEGER DEFAULT 7, tds_percent REAL DEFAULT 0, notes TEXT, items_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, run_count INTEGER NOT NULL DEFAULT 0,
  last_invoice_id INTEGER, last_run_at TEXT, source_invoice_id INTEGER
);
CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, created_by INTEGER,
  number TEXT NOT NULL, fy TEXT NOT NULL, series_int INTEGER NOT NULL,
  note_date TEXT NOT NULL, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  organisation_id INTEGER NOT NULL, reason TEXT,
  taxable REAL DEFAULT 0, tax_rate REAL DEFAULT 0, igst REAL DEFAULT 0, cgst REAL DEFAULT 0, sgst REAL DEFAULT 0, total REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  date TEXT NOT NULL, category TEXT, vendor TEXT, amount REAL NOT NULL DEFAULT 0, notes TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER, user_name TEXT, action TEXT, entity TEXT, entity_id INTEGER, summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_created ON activity_log(created_at);
`);
if (!cols('settings').length) db.exec(SETTINGS_SQL);
// tenant 0 holds install-wide flags
export const getSetting = (k, dflt, tid = 0) => { const r = get('SELECT value FROM settings WHERE tenant_id = ? AND key = ?', tid, k); return r ? JSON.parse(r.value) : dflt; };
export const setSetting = (k, v, tid = 0) => run('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value', tid, k, JSON.stringify(v));

addCol('invoices', 'gst_applied', 'INTEGER DEFAULT 1');
addCol('invoices', 'pay_qr', 'INTEGER DEFAULT 1');
addCol('invoices', 'pay_upi', 'INTEGER DEFAULT 1');
addCol('invoices', 'pay_bank', 'INTEGER DEFAULT 1');
addCol('organisations', 'qr_image', 'TEXT');
addCol('recurring_invoices', 'gst_applied', 'INTEGER DEFAULT 1');
addCol('recurring_invoices', 'pay_qr', 'INTEGER DEFAULT 1');
addCol('recurring_invoices', 'pay_upi', 'INTEGER DEFAULT 1');
addCol('recurring_invoices', 'pay_bank', 'INTEGER DEFAULT 1');

/* ---- v3: organisation signup (multi-tenant) ---- */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const normCode = (c) => {
  const x = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x.length === 10 ? `${x.slice(0, 5)}-${x.slice(5)}` : null;
};
export function newInviteCode() {
  for (;;) {
    const code = normCode(Array.from({ length: 10 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''));
    if (!get('SELECT 1 AS x FROM tenants WHERE invite_code = ?', code)) return code;
  }
}

// Every organisation-owned table carries tenant_id; child rows (items, payments) are reached through their invoice.
const TENANT_TABLES = ['organisations', 'clients', 'service_products', 'invoices', 'message_templates', 'reminder_log', 'email_notify',
  'recurring_invoices', 'credit_notes', 'expenses', 'activity_log'];
for (const t of TENANT_TABLES) {
  addCol(t, 'tenant_id', 'INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id)`);
}

if (legacy) {
  // Existing single-company data becomes organisation #1; everyone already there stays an approved member.
  db.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    const first = get('SELECT name FROM organisations ORDER BY id LIMIT 1');
    const tid = run('INSERT INTO tenants (name, invite_code) VALUES (?, ?)', first?.name || 'My organisation', newInviteCode()).lastInsertRowid;
    db.exec(`${ROLES_SQL.replace('IF NOT EXISTS roles', 'roles_new')};
      INSERT INTO roles_new (id, tenant_id, name, permissions) SELECT id, ${tid}, name, permissions FROM roles;
      DROP TABLE roles; ALTER TABLE roles_new RENAME TO roles;
      ${USERS_SQL.replace('IF NOT EXISTS users', 'users_new')};
      INSERT INTO users_new SELECT id, name, email, password_hash, role_id, active, created_at FROM users;
      DROP TABLE users; ALTER TABLE users_new RENAME TO users;
      ALTER TABLE settings RENAME TO settings_old; ${SETTINGS_SQL};
      INSERT INTO settings (tenant_id, key, value) SELECT ${tid}, key, value FROM settings_old WHERE key != 'perms_v2';
      INSERT INTO settings (tenant_id, key, value) SELECT 0, key, value FROM settings_old WHERE key = 'perms_v2';
      DROP TABLE settings_old;`);
    for (const t of TENANT_TABLES) run(`UPDATE ${t} SET tenant_id = ? WHERE tenant_id IS NULL`, tid);
    run(`INSERT INTO memberships (tenant_id, user_id, role, status, decided_at)
         SELECT ?, u.id, CASE WHEN r.permissions LIKE '%"*"%' THEN 'admin' ELSE 'member' END, 'approved', CURRENT_TIMESTAMP
         FROM users u JOIN roles r ON r.id = u.role_id`, tid);
    run("UPDATE tenants SET created_by = (SELECT MIN(user_id) FROM memberships WHERE tenant_id = ? AND role = 'admin') WHERE id = ?", tid, tid);
  });
  db.exec('PRAGMA foreign_keys = ON');
}

// Platform "management" accounts see every organisation's summary (no organisation membership needed)
addCol('users', 'is_management', 'INTEGER NOT NULL DEFAULT 0');
addCol('clients', 'status', "TEXT NOT NULL DEFAULT 'active'"); // active | inactive | on_hold
