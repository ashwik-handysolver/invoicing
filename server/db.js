import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const file = process.env.DB_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'invoice.db');
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const clean = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? +x : x));
export const all = (sql, ...p) => db.prepare(sql).all(...clean(p));
export const get = (sql, ...p) => db.prepare(sql).get(...clean(p));
export const run = (sql, ...p) => db.prepare(sql).run(...clean(p));
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
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
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
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
export const getSetting = (k, dflt) => { const r = get('SELECT value FROM settings WHERE key = ?', k); return r ? JSON.parse(r.value) : dflt; };
export const setSetting = (k, v) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));

addCol('invoices', 'gst_applied', 'INTEGER DEFAULT 1');
addCol('invoices', 'pay_qr', 'INTEGER DEFAULT 1');
addCol('invoices', 'pay_upi', 'INTEGER DEFAULT 1');
addCol('invoices', 'pay_bank', 'INTEGER DEFAULT 1');
addCol('organisations', 'qr_image', 'TEXT');
addCol('recurring_invoices', 'gst_applied', 'INTEGER DEFAULT 1');
addCol('recurring_invoices', 'pay_qr', 'INTEGER DEFAULT 1');
addCol('recurring_invoices', 'pay_upi', 'INTEGER DEFAULT 1');
addCol('recurring_invoices', 'pay_bank', 'INTEGER DEFAULT 1');
