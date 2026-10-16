import './env.js'; // must stay first: loads .env before other modules read process.env
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, tx } from './db.js';
import { calcInvoice, financialYear, paymentStatus, r2, stateCode, STATES } from './calc.js';
import { seedIfEmpty, ensureManagement, normalizeRoles } from './seed.js';
import qrcode from 'qrcode-generator';
import { logAct } from './activity.js';
import { ensureDefaults, ensureRolePerms, init as initFeatures, registerGst } from './features.js';
import { registerOrgs } from './orgs.js';
import { registerVoice } from './voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));

/* ---------------------------------------------------------------- RBAC */
export const PERMISSIONS = {
  dashboard: ['view', 'export'],
  invoices: ['view', 'create', 'edit', 'delete', 'export'],
  payments: ['create', 'delete'],
  clients: ['view', 'create', 'edit', 'delete'],
  products: ['view', 'create', 'edit', 'delete'],
  reminders: ['view', 'send'],
  recurring: ['view', 'create', 'edit', 'delete'],
  expenses: ['view', 'create', 'edit', 'delete'],
  gst: ['view', 'export'],
  activity: ['view'],
  templates: ['view', 'create', 'edit', 'delete'],
  settings: ['view', 'edit'],
  users: ['view', 'create', 'edit', 'delete'],
  roles: ['view', 'create', 'edit', 'delete'],
};
const ALL_KEYS = Object.entries(PERMISSIONS).flatMap(([m, acts]) => acts.map((a) => `${m}.${a}`));

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export { hashPassword };

const hasPerm = (perms, key) => perms.includes('*') || perms.includes(key);
const SESSION_DAYS = 30;

const newSession = (userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId);
  return token;
};

// Signed-in user + their organisation membership. Permissions apply only while the membership is approved.
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const row = token && get(
    `SELECT u.id, u.name, u.email, u.active, u.role_id, u.is_management, s.created_at AS sess_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
  if (!row || !row.active || Date.now() - new Date(row.sess_at + 'Z').getTime() > SESSION_DAYS * 864e5) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  const m = get(`SELECT m.tenant_id, m.role, m.status, m.created_at, m.decided_at, t.name AS tenant_name
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ?
       ORDER BY CASE m.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, m.id DESC LIMIT 1`, row.id);
  const approved = m?.status === 'approved';
  const role = approved ? get('SELECT name, permissions FROM roles WHERE id = ? AND tenant_id = ?', row.role_id, m.tenant_id) : null;
  const perms = role ? JSON.parse(role.permissions) : [];
  if (row.is_management) perms.push('management.view');
  req.user = { id: row.id, name: row.name, email: row.email, role: role?.name || (row.is_management ? 'Management' : null), perms, token, isManagement: !!row.is_management,
    tid: approved ? m.tenant_id : null, isAdmin: approved && m.role === 'admin',
    membership: m ? { status: m.status, role: m.role, organisation: m.tenant_name, requested_at: m.created_at, decided_at: m.decided_at } : null };
  next();
}
// Every route on `api` needs an approved membership; queries there are scoped with req.user.tid.
const member = (req, res, next) => (req.user.tid ? next()
  : res.status(403).json({ error: 'Your organisation access is not active yet.', code: 'no_membership' }));
const need = (key) => (req, res, next) =>
  hasPerm(req.user.perms, key) ? next() : res.status(403).json({ error: `You don't have permission (${key})` });

const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (/constraint/i.test(e.message)) {
      const msg = /FOREIGN KEY/i.test(e.message) ? 'This record is in use and cannot be deleted.'
        : /UNIQUE/i.test(e.message) ? 'That value already exists.' : 'Invalid data.';
      return res.status(409).json({ error: msg });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const today = () => new Date().toISOString().slice(0, 10);

/* ---------------------------------------------------------------- auth */
app.post('/api/login', wrap((req) => {
  const { email, password } = req.body || {};
  const u = get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', (email || '').trim());
  if (!u || !u.active || !checkPassword(password || '', u.password_hash)) throw fail(401, 'Wrong email or password');
  return { token: newSession(u.id) };
}));

// Public, read-only invoice page for clients (link shared by the owner)
app.get('/api/public/invoice/:token', wrap((req) => {
  const row = get('SELECT id, tenant_id FROM invoices WHERE share_token = ?', req.params.token);
  if (!row) throw fail(404, 'This link is no longer valid');
  run('UPDATE invoices SET view_count = COALESCE(view_count,0) + 1, viewed_at = CURRENT_TIMESTAMP WHERE id = ?', row.id);
  const v = invoiceDetail(row.id, row.tenant_id);
  for (const k of ['created_by', 'share_token', 'payments', 'view_count', 'viewed_at', 'tenant_id']) delete v[k];
  return v;
}));
app.get('/p/:token', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const base = express.Router(); // signed in, in any membership state
base.use(auth);
base.post('/logout', wrap((req) => { run('DELETE FROM sessions WHERE token = ?', req.user.token); return { ok: true }; }));
base.get('/me', wrap((req) => {
  const { token, tid, ...user } = req.user;
  return { user };
}));
registerOrgs({ app, base, wrap, fail, hashPassword, checkPassword, newSession, hasPerm });
app.use('/api', base);
const api = express.Router();
api.use(member);
base.use(api);
// Optional live lookup through a GST verification provider (Appyflow-style API). Enabled only when GST_API_KEY is set.
api.get('/gst-lookup/:gstin', async (req, res) => {
  try {
    const key = process.env.GST_API_KEY;
    if (!key) throw fail(501, 'GST lookup is not set up. Add GST_API_KEY on the server.');
    const gstin = String(req.params.gstin).toUpperCase();
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw fail(400, 'Not a valid GSTIN');
    const base = process.env.GST_API_URL || 'https://appyflow.in/api/verifyGST';
    const r = await fetch(`${base}?gstNo=${gstin}&key_secret=${encodeURIComponent(key)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw fail(502, j.message || 'GST lookup failed');
    const t = j.taxpayerInfo || j, a = t.pradr?.addr || {};
    const addr = t.pradr?.adr || [a.bno, a.flno, a.bnm, a.st, a.loc, a.city, a.dst, a.stcd, a.pncd].filter(Boolean).join(', ');
    res.json({ gstin, name: t.tradeNam || t.lgnm || '', legal_name: t.lgnm || '', address: addr, status: t.sts || '' });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Lookup failed' }); }
});
api.get('/meta', wrap((req) => ({
  gst_lookup: !!process.env.GST_API_KEY,
  states: STATES,
  permissions: PERMISSIONS,
  organisations: all('SELECT * FROM organisations WHERE tenant_id = ? ORDER BY name', req.user.tid),
})));

/* ---------------------------------------------------------------- generic CRUD */
function crud(name, table, cols, { perm = name, write, order = 'id DESC', beforeSave, afterSave } = {}) {
  const key = (a) => `${perm}.${write && a !== 'view' ? write : a}`;
  const pick = (body) => {
    const o = {};
    for (const c of cols) if (body[c] !== undefined) o[c] = typeof body[c] === 'string' ? body[c].trim() : body[c];
    return beforeSave ? beforeSave(o, body) : o;
  };
  const one = (req) => get(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`, req.params.id, req.user.tid) || (() => { throw fail(404, 'Not found'); })();
  api.get(`/${name}`, need(key('view')), wrap((req) => all(`SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY ${order}`, req.user.tid)));
  api.get(`/${name}/:id`, need(key('view')), wrap(one));
  api.post(`/${name}`, need(key('create')), wrap((req) => {
    const o = pick(req.body);
    if (!o[cols[0]]) throw fail(400, `${cols[0]} is required`);
    const keys = Object.keys(o);
    const r = run(`INSERT INTO ${table} (tenant_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, req.user.tid, ...keys.map((k) => o[k]));
    logAct(req.user, 'create', name, r.lastInsertRowid, String(o[cols[0]] ?? ''));
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, r.lastInsertRowid);
    afterSave && afterSave(req, row);
    return row;
  }));
  api.put(`/${name}/:id`, need(key('edit')), wrap((req) => {
    one(req);
    const o = pick(req.body);
    const keys = Object.keys(o);
    if (keys.length) run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ? AND tenant_id = ?`, ...keys.map((k) => o[k]), req.params.id, req.user.tid);
    logAct(req.user, 'update', name, +req.params.id, String(o[cols[0]] ?? ''));
    const row = one(req);
    afterSave && afterSave(req, row);
    return row;
  }));
  api.delete(`/${name}/:id`, need(key('delete')), wrap((req) => { const old = one(req); run(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`, old.id, req.user.tid); logAct(req.user, 'delete', name, old.id, String(old[cols[0]] ?? '')); return { ok: true }; }));
}

const withState = (o) => {
  if (o.gst_number) o.gst_number = o.gst_number.toUpperCase();
  if (/^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(o.gst_number || '') && !o.pan_number) o.pan_number = o.gst_number.slice(2, 12); // PAN sits inside the GSTIN
  const code = stateCode(o);
  if (code) { o.state_code = code; if (STATES[code]) o.state = STATES[code]; }
  return o;
};
export const CLIENT_STATUSES = ['active', 'inactive', 'on_hold'];
const checkClient = (o) => {
  if (o.status !== undefined && !CLIENT_STATUSES.includes(o.status)) throw fail(400, 'Status must be active, inactive or on_hold');
  return withState(o);
};
crud('clients', 'clients', ['name', 'contact_person', 'email', 'mobile', 'address', 'gst_number', 'pan_number', 'state', 'state_code', 'status'], { order: 'name', beforeSave: checkClient });
crud('products', 'service_products', ['name', 'sac_number', 'description', 'price', 'tax'], { order: 'name' });
crud('templates', 'message_templates', ['name', 'channel', 'kind', 'subject', 'body'], { order: 'channel, kind, name' });

// Organisations + CC emails live under "settings"
const checkOrg = (o) => {
  if (o.name !== undefined && !o.name) throw fail(400, 'Organisation name is required');
  if (o.name && o.name.length > 160) throw fail(400, 'Organisation name is too long');
  if (o.gst_number && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(o.gst_number.toUpperCase())) throw fail(400, 'GSTIN should be 15 characters, like 06AABCA1234F1Z5');
  if (o.pan_number && !/^[A-Z]{5}\d{4}[A-Z]$/.test(o.pan_number.toUpperCase())) throw fail(400, 'PAN should look like AABCA1234F');
  if (o.pan_number) o.pan_number = o.pan_number.toUpperCase();
  if (o.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email)) throw fail(400, 'Enter a valid organisation email');
  return withState(o);
};
const syncTenantName = (req, row) => {
  if (row.id === get('SELECT MIN(id) AS id FROM organisations WHERE tenant_id = ?', req.user.tid).id) run('UPDATE tenants SET name = ? WHERE id = ?', row.name, req.user.tid);
};
crud('organisations', 'organisations', ['name', 'address', 'gst_number', 'pan_number', 'email', 'contact', 'bank_details', 'logo', 'signature', 'qr_image', 'footer_note', 'terms', 'upi_id', 'state', 'state_code'], { perm: 'settings', write: 'edit', order: 'name', beforeSave: checkOrg, afterSave: syncTenantName });
crud('cc-emails', 'email_notify', ['email'], { perm: 'settings', write: 'edit', order: 'email' });

/* ---------------------------------------------------------------- roles & users */
// User types are fixed per organisation (Admin, Team member): roles can be listed, not created, edited or deleted.
api.use('/roles', (req, res, next) => (req.method === 'GET' ? next() : res.status(400).json({ error: 'User types are fixed: Admin and Team member.' })));
api.get('/roles', (req, res, next) => (hasPerm(req.user.perms, 'roles.view') || hasPerm(req.user.perms, 'users.view') ? next() : res.status(403).json({ error: "You don't have permission (users.view)" })), wrap((req) => all('SELECT * FROM roles WHERE tenant_id = ? ORDER BY id', req.user.tid).map((r) => ({ ...r, permissions: JSON.parse(r.permissions) }))));
const tenantRole = (id, tid) => {
  const r = id && get('SELECT * FROM roles WHERE id = ? AND tenant_id = ?', id, tid);
  if (!r) throw fail(400, 'Pick a valid role');
  return { ...r, admin: JSON.parse(r.permissions).includes('*') };
};
const cleanPerms = (p) => (Array.isArray(p) ? p.filter((k) => ALL_KEYS.includes(k)) : []);
api.post('/roles', need('roles.create'), wrap((req) => {
  const name = (req.body.name || '').trim();
  if (!name) throw fail(400, 'Name is required');
  const r = run('INSERT INTO roles (tenant_id, name, permissions) VALUES (?, ?, ?)', req.user.tid, name, JSON.stringify(cleanPerms(req.body.permissions)));
  logAct(req.user, 'create', 'role', r.lastInsertRowid, name);
  return { id: r.lastInsertRowid };
}));
api.put('/roles/:id', need('roles.edit'), wrap((req) => {
  const role = get('SELECT * FROM roles WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid);
  if (!role) throw fail(404, 'Not found');
  if (JSON.parse(role.permissions).includes('*')) throw fail(400, 'The Admin role cannot be changed');
  run('UPDATE roles SET name = ?, permissions = ? WHERE id = ?', (req.body.name || role.name).trim(), JSON.stringify(cleanPerms(req.body.permissions)), role.id);
  logAct(req.user, 'update', 'role', role.id, `${role.name} permissions changed`);
  return { ok: true };
}));
api.delete('/roles/:id', need('roles.delete'), wrap((req) => {
  const role = get('SELECT * FROM roles WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid);
  if (!role) throw fail(404, 'Not found');
  if (JSON.parse(role.permissions).includes('*')) throw fail(400, 'The Admin role cannot be deleted');
  if (get('SELECT 1 AS x FROM users WHERE role_id = ?', role.id)) throw fail(409, 'This role is assigned to users. Move them to another role first.');
  run('DELETE FROM roles WHERE id = ?', role.id);
  return { ok: true };
}));

const userRow = `SELECT u.id, u.name, u.email, u.active, u.role_id, r.name AS role, m.role AS membership_role
  FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN roles r ON r.id = u.role_id WHERE m.tenant_id = ? AND m.status = 'approved'`;
const memberOf = (req) => get(`${userRow} AND u.id = ?`, req.user.tid, req.params.id) || (() => { throw fail(404, 'Not found'); })();
const adminCount = (tid) => get("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND status = 'approved' AND role = 'admin'", tid).n;
api.get('/users', need('users.view'), wrap((req) => all(`${userRow} ORDER BY u.name`, req.user.tid)));
api.post('/users', need('users.create'), wrap((req) => {
  const { name, email, password, role_id } = req.body;
  if (!name || !email || !password || !role_id) throw fail(400, 'Name, email, password and role are required');
  if (password.length < 6) throw fail(400, 'Password must be at least 6 characters');
  const role = tenantRole(role_id, req.user.tid);
  if (role.admin && !req.user.isAdmin) throw fail(403, 'Only admins can add admins');
  if (get('SELECT 1 AS x FROM users WHERE email = ?', email.trim())) throw fail(409, 'This email already has an account. Ask them to join with your organisation code.');
  const id = tx(() => {
    const uid = run('INSERT INTO users (name, email, password_hash, role_id) VALUES (?,?,?,?)', name.trim(), email.trim().toLowerCase(), hashPassword(password), role.id).lastInsertRowid;
    run("INSERT INTO memberships (tenant_id, user_id, role, status, decided_at, decided_by) VALUES (?, ?, ?, 'approved', CURRENT_TIMESTAMP, ?)", req.user.tid, uid, role.admin ? 'admin' : 'member', req.user.id);
    return uid;
  });
  logAct(req.user, 'create', 'user', id, email);
  return { id };
}));
api.put('/users/:id', need('users.edit'), wrap((req) => {
  const { name, email, password, role_id, active } = req.body;
  const u = memberOf(req), cur = get('SELECT * FROM users WHERE id = ?', u.id);
  if (u.membership_role === 'admin' && !req.user.isAdmin) throw fail(403, 'Only admins can change an admin account');
  if (u.id === req.user.id && (active === false || active === 0)) throw fail(400, "You can't deactivate yourself");
  if (password && password.length < 6) throw fail(400, 'Password must be at least 6 characters');
  const role = role_id && +role_id !== u.role_id ? tenantRole(role_id, req.user.tid) : null;
  if (role && u.id === req.user.id) throw fail(400, "You can't change your own role");
  if (role?.admin && !req.user.isAdmin) throw fail(403, 'Only admins can make someone an admin');
  if (role && !role.admin && u.membership_role === 'admin' && adminCount(req.user.tid) <= 1) throw fail(400, 'Your organisation needs at least one admin');
  tx(() => {
    run('UPDATE users SET name = ?, email = ?, role_id = ?, active = ?, password_hash = ? WHERE id = ?',
      (name || cur.name).trim(), (email || cur.email).trim().toLowerCase(), role ? role.id : cur.role_id,
      active === undefined ? cur.active : +!!active, password ? hashPassword(password) : cur.password_hash, u.id);
    if (role) run('UPDATE memberships SET role = ? WHERE user_id = ? AND tenant_id = ?', role.admin ? 'admin' : 'member', u.id, req.user.tid);
  });
  logAct(req.user, 'update', 'user', u.id, u.email);
  if (password || active === false || active === 0) run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, req.user.token);
  return { ok: true };
}));
api.delete('/users/:id', need('users.delete'), wrap((req) => {
  if (+req.params.id === req.user.id) throw fail(400, "You can't delete yourself");
  const u = memberOf(req);
  if (u.membership_role === 'admin' && !req.user.isAdmin) throw fail(403, 'Only admins can remove an admin');
  run('DELETE FROM users WHERE id = ?', u.id);
  logAct(req.user, 'delete', 'user', u.id, u.email);
  return { ok: true };
}));
/* ---------------------------------------------------------------- invoices */
const PREFIX = { proforma: 'PI', tax: 'TI' };

function nextNumber(orgId, type, fy) { // organisation ids are already tenant-checked
  const row = get('SELECT MAX(invoice_series_int) AS m FROM invoices WHERE organisation_id = ? AND invoice_type = ? AND fy = ?', orgId, type, fy);
  const n = (row?.m || 0) + 1;
  return { n, number: `INV/${fy}/${PREFIX[type]}/${String(n).padStart(4, '0')}` };
}

function refreshPaid(invoiceId) {
  const inv = get('SELECT net_amount FROM invoices WHERE id = ?', invoiceId);
  const paid = r2(get('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ?', invoiceId).s);
  const credit = r2(get('SELECT COALESCE(SUM(total),0) AS s FROM credit_notes WHERE invoice_id = ?', invoiceId).s);
  const eff = r2(inv.net_amount - credit); // credit notes reduce what is owed
  run('UPDATE invoices SET paid_amount = ?, credit_amount = ?, balance_amount = ?, payment_status = ? WHERE id = ?',
    paid, credit, r2(eff - paid), eff <= 0.005 ? 'paid' : paymentStatus(eff, paid), invoiceId);
}

function insertItems(invoiceId, items) {
  for (const it of items) {
    run(`INSERT INTO invoice_items (invoice_id, service_product_id, position, sac_number, description, price, quantity,
         gross_amount, discount_percent, discount_amount, selling_amount, tax, igst, cgst, sgst, total_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      invoiceId, it.service_product_id, it.position, it.sac_number, it.description, it.price, it.quantity,
      it.gross_amount, it.discount_percent, it.discount_amount, it.selling_amount, it.tax, it.igst, it.cgst, it.sgst, it.total_amount);
  }
}

function saveInvoice(tid, body, userId, id) {
  const org = get('SELECT * FROM organisations WHERE id = ? AND tenant_id = ?', body.organisation_id, tid);
  const client = get('SELECT * FROM clients WHERE id = ? AND tenant_id = ?', body.client_id, tid);
  if (!org || !client) throw fail(400, 'Organisation and client are required');
  if (!Array.isArray(body.items) || !body.items.length) throw fail(400, 'Add at least one line item');
  if (body.items.some((i) => !(+i.quantity > 0) || !(+i.price >= 0))) throw fail(400, 'Every line needs a quantity and price');
  const type = id ? (get('SELECT invoice_type FROM invoices WHERE id = ? AND tenant_id = ?', id, tid) || (() => { throw fail(404, 'Invoice not found'); })()).invoice_type : body.invoice_type;
  if (!PREFIX[type]) throw fail(400, 'Invalid invoice type');
  const date = body.invoice_date || today();
  const orgCode = stateCode(org), clientCode = stateCode(client);
  const intra = !!orgCode && orgCode === clientCode;
  const gst = !(body.gst_applied === false || body.gst_applied === 0 || body.gst_applied === '0'); // "without GST" invoices carry no tax at all
  const flag = (v) => (v === undefined || v === null ? 1 : +!!v);
  const { items, totals: t } = calcInvoice({ items: gst ? body.items : body.items.map((i) => ({ ...i, tax: 0 })), intra, tdsPercent: body.tds_percent });

  const snap = [
    org.name, org.address, org.email, org.contact, org.gst_number, org.bank_details,
    client.name, client.address, client.email, client.mobile, client.gst_number,
    STATES[clientCode] ? `${STATES[clientCode]} (${clientCode})` : client.state || '',
  ];
  const amounts = [t.gross, t.disc, t.sell, t.igst, t.cgst, t.sgst, +body.tds_percent || 0, t.tds_amount, t.total, t.net];

  return tx(() => {
    if (id) {
      run(`UPDATE invoices SET invoice_date=?, due_date=?, organisation_id=?, client_id=?,
           org_name=?, org_address=?, org_email=?, org_contact=?, org_gst=?, org_bank=?,
           client_name=?, client_address=?, client_email=?, client_contact=?, client_gst=?, place_of_supply=?,
           gross_amount=?, discount_amount=?, selling_amount=?, igst=?, cgst=?, sgst=?, tds_percent=?, tds_amount=?,
           total_amount=?, net_amount=?, notes=? WHERE id=?`,
        date, body.due_date || null, org.id, client.id, ...snap, ...amounts, body.notes || null, id);
      run('DELETE FROM invoice_items WHERE invoice_id = ?', id);
    } else {
      const fy = financialYear(date);
      const { n, number } = nextNumber(org.id, type, fy);
      id = run(`INSERT INTO invoices (tenant_id, created_by, invoice_type, invoice_number, invoice_series_int, fy, invoice_date, due_date,
           organisation_id, client_id,
           org_name, org_address, org_email, org_contact, org_gst, org_bank,
           client_name, client_address, client_email, client_contact, client_gst, place_of_supply,
           gross_amount, discount_amount, selling_amount, igst, cgst, sgst, tds_percent, tds_amount, total_amount, net_amount,
           notes, converted_from_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        tid, userId, type, number, n, fy, date, body.due_date || null, org.id, client.id, ...snap, ...amounts,
        body.notes || null, body.converted_from_id || null).lastInsertRowid;
    }
    insertItems(id, items);
    run('UPDATE invoices SET gst_applied = ?, pay_qr = ?, pay_upi = ?, pay_bank = ? WHERE id = ?', +gst, flag(body.pay_qr), flag(body.pay_upi), flag(body.pay_bank), id);
    refreshPaid(id);
    return id;
  });
}

// UPI deep link; amount = what is still to be paid (tax) or the full total (proforma).
function upiLink(inv) {
  const pa = (inv.org_upi || '').trim();
  const amt = inv.invoice_type === 'tax' ? inv.balance_amount : inv.net_amount;
  if (!pa || !(amt > 0.005)) return null;
  return `upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(inv.org_name || '')}&am=${r2(amt).toFixed(2)}&cu=INR&tn=${encodeURIComponent(inv.invoice_number)}`;
}

function invoiceDetail(id, tid) {
  const inv = get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', id, tid);
  if (!inv) throw fail(404, 'Invoice not found');
  inv.items = all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position', id);
  inv.payments = all('SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE invoice_id = ? ORDER BY paid_on, id', id);
  const o = get('SELECT logo, signature, qr_image, footer_note, terms, upi_id, pan_number AS org_pan FROM organisations WHERE id = ?', inv.organisation_id) || {};
  Object.assign(inv, { org_logo: o.logo, org_signature: o.signature, org_footer: o.footer_note, org_terms: o.terms, org_pan: o.org_pan });
  // Payment options chosen for this invoice: QR code, UPI id, bank transfer
  inv.gst_applied = !!inv.gst_applied;
  if (!inv.pay_bank) inv.org_bank = null;
  inv.show_upi = !!(inv.pay_upi && o.upi_id);
  inv.org_upi = inv.show_upi || (inv.pay_qr && o.upi_id) ? o.upi_id : null;
  const link = inv.pay_upi || inv.pay_qr ? upiLink(inv) : null;
  if (link) inv.upi_link = link;
  if (inv.pay_qr && /^data:image\/(png|jpeg|jpg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(o.qr_image || '')) inv.upi_qr = `<img src="${o.qr_image}" alt="Payment QR code">`;
  else if (inv.pay_qr && link) { const q = qrcode(0, 'M'); q.addData(link); q.make(); inv.upi_qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
  inv.credit_notes = all('SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY id', id);
  inv.intra = inv.cgst > 0 || inv.sgst > 0;
  return inv;
}

api.get('/invoices', need('invoices.view'), wrap((req) => {
  const { type, status, q, client_id, from, to } = req.query;
  const w = ['i.tenant_id = ?'], p = [req.user.tid];
  if (type) { w.push('i.invoice_type = ?'); p.push(type); }
  if (client_id) { w.push('i.client_id = ?'); p.push(client_id); }
  if (from) { w.push('i.invoice_date >= ?'); p.push(from); }
  if (to) { w.push('i.invoice_date <= ?'); p.push(to); }
  if (status === 'overdue') { w.push("i.balance_amount > 0.005 AND i.due_date < ? AND i.invoice_type = 'tax'"); p.push(today()); }
  else if (status) { w.push('i.payment_status = ?'); p.push(status); }
  if (q) { w.push('(i.invoice_number LIKE ? OR i.client_name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  return all(`SELECT i.id, i.invoice_number, i.invoice_type, i.invoice_date, i.due_date, i.client_id, i.client_name,
      i.total_amount, i.net_amount, i.paid_amount, i.balance_amount, i.payment_status, i.converted_to_id
      FROM invoices i WHERE ${w.join(' AND ')} ORDER BY i.invoice_date DESC, i.id DESC LIMIT 500`, ...p);
}));
api.get('/invoices/:id', need('invoices.view'), wrap((req) => invoiceDetail(req.params.id, req.user.tid)));
api.post('/invoices', need('invoices.create'), wrap((req) => {
  const id = saveInvoice(req.user.tid, req.body, req.user.id);
  const i = get('SELECT invoice_number, client_name, total_amount FROM invoices WHERE id = ?', id);
  logAct(req.user, 'create', 'invoice', id, `${i.invoice_number} for ${i.client_name} (₹${i.total_amount})`);
  return { id };
}));
api.put('/invoices/:id', need('invoices.edit'), wrap((req) => {
  const id = saveInvoice(req.user.tid, req.body, req.user.id, +req.params.id);
  logAct(req.user, 'update', 'invoice', id, get('SELECT invoice_number FROM invoices WHERE id = ?', id).invoice_number);
  return { id };
}));
api.delete('/invoices/:id', need('invoices.delete'), wrap((req) => {
  const inv = get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid);
  if (!inv) throw fail(404, 'Not found');
  if (inv.converted_from_id) run('UPDATE invoices SET converted_to_id = NULL WHERE id = ?', inv.converted_from_id);
  run('DELETE FROM invoices WHERE id = ?', inv.id);
  logAct(req.user, 'delete', 'invoice', +req.params.id, inv?.invoice_number);
  return { ok: true };
}));

// Proforma -> Tax invoice (copies items, links both)
api.post('/invoices/:id/convert', need('invoices.create'), wrap((req) => {
  const pi = invoiceDetail(req.params.id, req.user.tid);
  if (pi.invoice_type !== 'proforma') throw fail(400, 'Only proforma invoices can be converted');
  if (pi.converted_to_id) throw fail(400, 'Already converted');
  const newId = saveInvoice(req.user.tid, {
    invoice_type: 'tax', invoice_date: today(), due_date: pi.due_date, organisation_id: pi.organisation_id,
    client_id: pi.client_id, items: pi.items, tds_percent: pi.tds_percent, notes: pi.notes, converted_from_id: pi.id,
    gst_applied: pi.gst_applied, pay_qr: pi.pay_qr, pay_upi: pi.pay_upi, pay_bank: pi.pay_bank,
  }, req.user.id);
  run('UPDATE invoices SET converted_to_id = ? WHERE id = ?', newId, pi.id);
  logAct(req.user, 'convert', 'invoice', newId, `${pi.invoice_number} → tax invoice`);
  return { id: newId };
}));

api.post('/invoices/:id/payments', need('payments.create'), wrap((req) => {
  const inv = get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid);
  if (!inv) throw fail(404, 'Not found');
  if (inv.invoice_type !== 'tax') throw fail(400, 'Record payments against the tax invoice');
  const amount = r2(req.body.amount);
  if (!(amount > 0)) throw fail(400, 'Enter a valid amount');
  if (amount > inv.balance_amount + 0.005) throw fail(400, `Amount is more than the balance (${inv.balance_amount})`);
  tx(() => {
    run('INSERT INTO payments (invoice_id, amount, paid_on, mode, reference, notes, created_by) VALUES (?,?,?,?,?,?,?)',
      inv.id, amount, req.body.paid_on || today(), req.body.mode || null, req.body.reference || null, req.body.notes || null, req.user.id);
    refreshPaid(inv.id);
  });
  logAct(req.user, 'payment', 'invoice', inv.id, `₹${amount} received on ${inv.invoice_number}`);
  return invoiceDetail(inv.id, req.user.tid);
}));
api.delete('/payments/:id', need('payments.delete'), wrap((req) => {
  const p = get('SELECT p.* FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ? AND i.tenant_id = ?', req.params.id, req.user.tid);
  if (!p) throw fail(404, 'Not found');
  tx(() => { run('DELETE FROM payments WHERE id = ?', p.id); refreshPaid(p.invoice_id); });
  logAct(req.user, 'delete', 'payment', p.id, `₹${p.amount} removed`);
  return { ok: true };
}));

// Every payment received, newest first (ledger view)
api.get('/payments', need('invoices.view'), wrap((req) => {
  const from = req.query.from || '0000-01-01', to = req.query.to || '9999-12-31';
  const rows = all(`SELECT p.id, p.amount, p.paid_on, p.mode, p.reference, p.notes, i.id AS invoice_id, i.invoice_number, i.client_id, i.client_name,
      i.net_amount, i.balance_amount FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE i.tenant_id = ? AND p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on DESC, p.id DESC LIMIT 500`, req.user.tid, from, to);
  const byMode = {};
  for (const r of rows) byMode[r.mode || 'Other'] = r2((byMode[r.mode || 'Other'] || 0) + r.amount);
  return { rows, total: r2(rows.reduce((s, r) => s + r.amount, 0)), byMode };
}));

api.post('/invoices/:id/share', need('invoices.view'), wrap((req) => {
  const inv = get('SELECT id, invoice_number, share_token FROM invoices WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid);
  if (!inv) throw fail(404, 'Not found');
  const token = inv.share_token || crypto.randomBytes(16).toString('hex');
  if (!inv.share_token) { run('UPDATE invoices SET share_token = ? WHERE id = ?', token, inv.id); logAct(req.user, 'share', 'invoice', inv.id, `${inv.invoice_number} link created`); }
  return { url: `${req.protocol}://${req.get('host')}/p/${token}` };
}));
api.delete('/invoices/:id/share', need('invoices.edit'), wrap((req) => {
  if (!run('UPDATE invoices SET share_token = NULL WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid).changes) throw fail(404, 'Not found');
  logAct(req.user, 'unshare', 'invoice', +req.params.id, 'link disabled');
  return { ok: true };
}));

/* ---------------------------------------------------------------- revenue dashboard */
function fyRange() {
  const d = new Date(), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out.slice(0, 60);
}

function revenueReport(tid, from, to) {
  const t = today();
  const billed = get(`SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS total, COALESCE(SUM(selling_amount),0) AS taxable,
      COALESCE(SUM(igst+cgst+sgst),0) AS gst, COALESCE(SUM(tds_amount),0) AS tds
      FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND invoice_date BETWEEN ? AND ?`, tid, from, to);
  const collected = get(`SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN invoices i ON i.id=p.invoice_id
      WHERE i.tenant_id = ? AND i.invoice_type='tax' AND p.paid_on BETWEEN ? AND ?`, tid, from, to).s;
  const recv = get(`SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount),0) AS s FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005`, tid);
  const overdue = get(`SELECT COUNT(*) AS n, COALESCE(SUM(balance_amount),0) AS s FROM invoices
      WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005 AND due_date < ?`, tid, t);
  const proforma = get(`SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE tenant_id = ? AND invoice_type='proforma' AND converted_to_id IS NULL AND invoice_date BETWEEN ? AND ?`, tid, from, to);

  const bm = Object.fromEntries(all(`SELECT substr(invoice_date,1,7) AS m, SUM(total_amount) AS s FROM invoices
      WHERE tenant_id = ? AND invoice_type='tax' AND invoice_date BETWEEN ? AND ? GROUP BY m`, tid, from, to).map((r) => [r.m, r.s]));
  const cm = Object.fromEntries(all(`SELECT substr(p.paid_on,1,7) AS m, SUM(p.amount) AS s FROM payments p JOIN invoices i ON i.id=p.invoice_id
      WHERE i.tenant_id = ? AND i.invoice_type='tax' AND p.paid_on BETWEEN ? AND ? GROUP BY m`, tid, from, to).map((r) => [r.m, r.s]));
  const monthly = monthsBetween(from, to).map((m) => ({ month: m, billed: r2(bm[m]), collected: r2(cm[m]) }));

  const topClients = all(`SELECT client_id, client_name AS name, COUNT(*) AS invoices, SUM(total_amount) AS billed, SUM(balance_amount) AS pending
      FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND invoice_date BETWEEN ? AND ? GROUP BY client_id ORDER BY billed DESC LIMIT 5`, tid, from, to);

  const aging = { current: 0, d30: 0, d60: 0, d90: 0 };
  for (const r of all(`SELECT balance_amount, due_date FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005`, tid)) {
    const days = r.due_date ? Math.floor((Date.parse(t) - Date.parse(r.due_date)) / 864e5) : 0;
    const k = days <= 0 ? 'current' : days <= 30 ? 'd30' : days <= 60 ? 'd60' : 'd90';
    aging[k] = r2(aging[k] + r.balance_amount);
  }
  const recentPayments = all(`SELECT p.id, p.amount, p.paid_on, p.mode, i.id AS invoice_id, i.invoice_number, i.client_name
      FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.tenant_id = ? ORDER BY p.paid_on DESC, p.id DESC LIMIT 6`, tid);
  const credits = r2(get('SELECT COALESCE(SUM(total),0) AS s FROM credit_notes WHERE tenant_id = ? AND note_date BETWEEN ? AND ?', tid, from, to).s);
  billed.total = r2(billed.total - credits); billed.credits = credits;
  const expenses = get('SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM expenses WHERE tenant_id = ? AND date BETWEEN ? AND ?', tid, from, to);
  const expenseByCat = all("SELECT COALESCE(NULLIF(category,''),'Other') AS category, SUM(amount) AS s FROM expenses WHERE tenant_id = ? AND date BETWEEN ? AND ? GROUP BY 1 ORDER BY s DESC LIMIT 5", tid, from, to);
  const dueWeek = all(`SELECT i.id, i.invoice_number, i.client_id, i.client_name, i.due_date, i.balance_amount FROM invoices i
      WHERE i.tenant_id = ? AND i.invoice_type='tax' AND i.balance_amount > 0.005 AND i.due_date BETWEEN ? AND ? ORDER BY i.due_date LIMIT 8`, tid, t, new Date(Date.parse(t) + 7 * 864e5).toISOString().slice(0, 10));
  const overdueBy = Object.fromEntries(all(`SELECT client_id, SUM(balance_amount) AS s FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005 AND due_date < ? GROUP BY client_id`, tid, t).map((r) => [r.client_id, r.s]));
  const slowPayers = all(`SELECT i.client_id, i.client_name AS name, COUNT(*) AS invoices, AVG(julianday(lp.d) - julianday(i.invoice_date)) AS avg_days
      FROM invoices i JOIN (SELECT invoice_id, MAX(paid_on) AS d FROM payments GROUP BY invoice_id) lp ON lp.invoice_id = i.id
      WHERE i.tenant_id = ? AND i.invoice_type='tax' AND i.payment_status='paid' GROUP BY i.client_id ORDER BY avg_days DESC LIMIT 5`, tid)
    .map((r) => ({ ...r, avg_days: Math.round(r.avg_days), overdue: r2(overdueBy[r.client_id] || 0) }));
  return { from, to, billed, collected: r2(collected), receivable: recv, overdue, proforma, monthly, topClients, aging, recentPayments,
    expenses: { total: r2(expenses.s), count: expenses.n, byCategory: expenseByCat }, net: r2(collected - expenses.s), dueWeek, slowPayers };
}

api.get('/dashboard', need('dashboard.view'), wrap((req) => {
  const d = fyRange();
  return revenueReport(req.user.tid, req.query.from || d.from, req.query.to || d.to);
}));

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function sendCsv(res, filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + body); // BOM so Excel reads UTF-8
}
api.get('/export/revenue.csv', need('dashboard.export'), wrap((req, res) => {
  const d = fyRange();
  const from = req.query.from || d.from, to = req.query.to || d.to;
  const rows = all(`SELECT invoice_date, invoice_number, client_name, client_gst, selling_amount, igst, cgst, sgst, total_amount,
      tds_amount, net_amount, paid_amount, balance_amount, payment_status, due_date
      FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND invoice_date BETWEEN ? AND ? ORDER BY invoice_date, id`, req.user.tid, from, to);
  sendCsv(res, `revenue_${from}_to_${to}.csv`,
    ['Date', 'Invoice No', 'Client', 'Client GST', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total', 'TDS', 'Net Receivable', 'Paid', 'Balance', 'Status', 'Due Date'],
    rows.map((r) => Object.values(r)));
}));
api.get('/export/invoices.csv', need('invoices.export'), wrap((req, res) => {
  const rows = all(`SELECT invoice_number, invoice_type, invoice_date, due_date, client_name, total_amount, paid_amount, balance_amount, payment_status
      FROM invoices WHERE tenant_id = ? ORDER BY invoice_date DESC, id DESC`, req.user.tid);
  sendCsv(res, 'invoices.csv', ['Invoice No', 'Type', 'Date', 'Due Date', 'Client', 'Total', 'Paid', 'Balance', 'Status'], rows.map((r) => Object.values(r)));
}));

/* ---------------------------------------------------------------- reminders */
const daysOver = (due) => (due ? Math.max(0, Math.floor((Date.parse(today()) - Date.parse(due)) / 864e5)) : 0);
const inr = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? d.split('-').reverse().join('-') : '');

function pendingInvoices(tid, clientId) {
  return all(`SELECT id, invoice_number, invoice_date, due_date, total_amount, balance_amount, org_name, org_contact, organisation_id
      FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005 ${clientId ? 'AND client_id = ?' : ''}
      ORDER BY due_date`, tid, ...(clientId ? [clientId] : []));
}

api.get('/reminders', need('reminders.view'), wrap((req) => {
  const rows = all(`SELECT i.client_id, i.id, i.invoice_number, i.due_date, i.balance_amount, i.total_amount,
      c.name, c.mobile, c.email, c.contact_person
      FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.tenant_id = ? AND i.invoice_type='tax' AND i.balance_amount > 0.005 ORDER BY i.due_date`, req.user.tid);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.client_id)) {
      const last = get('SELECT created_at, channel FROM reminder_log WHERE client_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1', r.client_id, req.user.tid);
      map.set(r.client_id, { client_id: r.client_id, name: r.name, mobile: r.mobile, email: r.email, contact_person: r.contact_person,
        pending_count: 0, total_pending: 0, overdue_count: 0, max_days_overdue: 0, last_reminded: last?.created_at || null, invoices: [] });
    }
    const c = map.get(r.client_id), d = daysOver(r.due_date);
    c.pending_count++; c.total_pending = r2(c.total_pending + r.balance_amount);
    if (d > 0) c.overdue_count++;
    c.max_days_overdue = Math.max(c.max_days_overdue, d);
    c.invoices.push({ id: r.id, invoice_number: r.invoice_number, due_date: r.due_date, balance_amount: r.balance_amount, days_overdue: d });
  }
  return [...map.values()].sort((a, b) => b.max_days_overdue - a.max_days_overdue || b.total_pending - a.total_pending);
}));

api.get('/reminders/summary', wrap((req) => {
  if (!hasPerm(req.user.perms, 'reminders.view')) return { overdue_count: 0, pending_count: 0, total_pending: 0 };
  const r = get(`SELECT COUNT(*) AS pending_count, COALESCE(SUM(balance_amount),0) AS total_pending,
      COALESCE(SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END),0) AS overdue_count
      FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005`, today(), req.user.tid);
  return { ...r, queue_count: reminderQueue(req.user.tid).length };
}));

// Render a template for a client (all pending) and optionally one invoice.
api.post('/messages/render', wrap((req) => {
  const { template_id, client_id, invoice_id } = req.body;
  const tid = req.user.tid;
  const tpl = get('SELECT * FROM message_templates WHERE id = ? AND tenant_id = ?', template_id, tid);
  if (!tpl) throw fail(404, 'Template not found');
  const inv = invoice_id ? get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', invoice_id, tid) : null;
  if (invoice_id && !inv) throw fail(404, 'Invoice not found');
  const client = get('SELECT * FROM clients WHERE id = ? AND tenant_id = ?', client_id || inv?.client_id, tid);
  if (!client) throw fail(400, 'Client not found');
  const pend = pendingInvoices(tid, client.id);
  const org = inv ? get('SELECT * FROM organisations WHERE id = ?', inv.organisation_id) : get('SELECT * FROM organisations WHERE tenant_id = ? ORDER BY id LIMIT 1', tid);
  const total = r2(pend.reduce((s, x) => s + x.balance_amount, 0));
  const vars = {
    client_name: client.name, contact_person: client.contact_person || client.name,
    org_name: org?.name || '', org_contact: org?.contact || '', org_email: org?.email || '',
    pending_count: pend.length, total_pending: inr(total),
    overdue_count: pend.filter((x) => daysOver(x.due_date) > 0).length,
    invoice_list: pend.map((x) => `- ${x.invoice_number}: ${inr(x.balance_amount)}${x.due_date ? ` (due ${fmtDate(x.due_date)}${daysOver(x.due_date) ? `, ${daysOver(x.due_date)} days overdue` : ''})` : ''}`).join('\n'),
    invoice_number: inv?.invoice_number || '', invoice_date: fmtDate(inv?.invoice_date), due_date: fmtDate(inv?.due_date),
    invoice_total: inv ? inr(inv.total_amount) : '', invoice_balance: inv ? inr(inv.balance_amount) : '',
    days_overdue: inv ? daysOver(inv.due_date) : '',
    invoice_link: '', payment_amount: '', payment_date: '', payment_mode: '', payment_reference: '',
    upi_id: org?.upi_id || '',
    upi_link: inv && org?.upi_id ? upiLink({ ...inv, org_upi: org.upi_id }) || '' : '',
  };
  if (inv && /invoice_link/.test(tpl.body + (tpl.subject || ''))) {
    let tok = inv.share_token;
    if (!tok) { tok = crypto.randomBytes(16).toString('hex'); run('UPDATE invoices SET share_token = ? WHERE id = ?', tok, inv.id); }
    vars.invoice_link = `${req.protocol}://${req.get('host')}/p/${tok}`;
  }
  const pay = req.body.payment_id ? get('SELECT p.* FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ? AND i.tenant_id = ?', req.body.payment_id, tid) : null;
  if (pay) Object.assign(vars, { payment_amount: inr(pay.amount), payment_date: fmtDate(pay.paid_on), payment_mode: pay.mode || '', payment_reference: pay.reference || '' });
  const fill = (s) => (s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));
  const text = fill(tpl.body), subject = fill(tpl.subject);
  let mobile = (client.mobile || '').replace(/\D/g, '');
  if (mobile.length === 10) mobile = '91' + mobile;
  const cc = all('SELECT email FROM email_notify WHERE tenant_id = ?', tid).map((r) => r.email).join(',');
  const to = inv?.client_email || client.email || '';
  return {
    channel: tpl.channel, text, subject, to_email: to, cc, mobile,
    whatsapp_url: mobile ? `https://wa.me/${mobile}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`,
    mailto_url: `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}${cc ? `&cc=${encodeURIComponent(cc)}` : ''}`,
  };
}));
api.get('/messages/templates', wrap((req) => all('SELECT * FROM message_templates WHERE tenant_id = ? ORDER BY channel, kind, name', req.user.tid)));
api.post('/messages/log', need('reminders.send'), wrap((req) => {
  const tid = req.user.tid;
  if (req.body.client_id && !get('SELECT 1 AS x FROM clients WHERE id = ? AND tenant_id = ?', req.body.client_id, tid)) throw fail(404, 'Client not found');
  if (req.body.invoice_id && !get('SELECT 1 AS x FROM invoices WHERE id = ? AND tenant_id = ?', req.body.invoice_id, tid)) throw fail(404, 'Invoice not found');
  run('INSERT INTO reminder_log (tenant_id, client_id, invoice_id, channel, template_id, sent_by, rule) VALUES (?,?,?,?,?,?,?)',
    tid, req.body.client_id, req.body.invoice_id || null, req.body.channel, req.body.template_id, req.user.id, req.body.rule ?? null);
  logAct(req.user, 'sent', 'message', req.body.invoice_id || req.body.client_id, `${req.body.channel} message opened`);
  return { ok: true };
}));

/* ---------------------------------------------------------------- static + start */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') })); // always revalidate, so updates show without a hard refresh

seedIfEmpty({ saveInvoice, refreshPaid, hashPassword });
ensureManagement(hashPassword);
normalizeRoles();
ensureDefaults();
ensureRolePerms();
const { reminderQueue } = initFeatures({ api, need, wrap, fail, crud, saveInvoice, invoiceDetail, refreshPaid });
registerGst({ api, need, wrap });
registerVoice({ api, wrap, fail, hasPerm, refreshPaid, withState });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Invoice app running on http://localhost:${port}`));
