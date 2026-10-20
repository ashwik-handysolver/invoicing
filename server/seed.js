import { all, get, run, tx, newInviteCode, getSetting, setSetting } from './db.js';
import { PERMISSIONS } from './index.js';
import { DUMMY_COMPANY } from './dummy.js';

const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// Everyday work: invoices, payments, clients, reminders… but no deleting, users or settings.
const TEAM_MEMBER = [
  'dashboard.view', 'dashboard.export', 'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.export',
  'payments.create', 'clients.view', 'clients.create', 'clients.edit', 'products.view', 'products.create', 'products.edit',
  'reminders.view', 'reminders.send', 'templates.view', 'templates.create', 'templates.edit',
  'recurring.view', 'recurring.create', 'recurring.edit', 'expenses.view', 'expenses.create', 'expenses.edit', 'gst.view', 'gst.export',
  'tasks.view', 'tasks.create', 'tasks.edit', 'tasks.delete',
];
// Every organisation has exactly two user types. (Platform "management" accounts are separate: users.is_management.)
export const DEFAULT_MEMBER_ROLE = 'Team member';

// Roles + message templates every new organisation starts with. Returns { Admin, 'Team member' } role ids.
export function createTenantDefaults(tid) {
  const roleId = {};
  for (const [name, perms] of [['Admin', ['*']], [DEFAULT_MEMBER_ROLE, TEAM_MEMBER]]) {
    roleId[name] = run('INSERT INTO roles (tenant_id, name, permissions) VALUES (?, ?, ?)', tid, name, JSON.stringify(perms)).lastInsertRowid;
  }
  const tpl = (name, channel, kind, subject, body) =>
    run('INSERT INTO message_templates (tenant_id, name, channel, kind, subject, body) VALUES (?,?,?,?,?,?)', tid, name, channel, kind, subject, body);
  tpl('Payment reminder (all pending)', 'whatsapp', 'reminder', null,
    'Hello {{contact_person}},\n\nThis is a friendly reminder from {{org_name}}. You have {{pending_count}} pending invoice(s) totalling {{total_pending}}:\n\n{{invoice_list}}\n\nKindly arrange the payment at the earliest. Please ignore if already paid.\n\nThank you,\n{{org_name}} {{org_contact}}');
  tpl('Payment reminder (all pending)', 'email', 'reminder', 'Payment reminder - {{total_pending}} pending',
    'Dear {{contact_person}},\n\nThis is a gentle reminder that {{pending_count}} invoice(s) from {{org_name}} are pending, totalling {{total_pending}}:\n\n{{invoice_list}}\n\nKindly arrange the payment at the earliest. If you have already paid, please share the payment details so we can update our records.\n\nRegards,\n{{org_name}}\n{{org_contact}}');
  tpl('Overdue invoice notice', 'whatsapp', 'reminder', null,
    'Hello {{contact_person}}, invoice {{invoice_number}} of {{invoice_total}} was due on {{due_date}} ({{days_overdue}} days ago). Balance pending: {{invoice_balance}}. Kindly pay at the earliest. - {{org_name}}');
  tpl('Send invoice', 'whatsapp', 'invoice', null,
    'Hello {{contact_person}}, please find invoice {{invoice_number}} dated {{invoice_date}} for {{invoice_total}}. Due date: {{due_date}}. Thank you - {{org_name}}\n\nView / pay online: {{invoice_link}}');
  tpl('Send invoice', 'email', 'invoice', 'Invoice {{invoice_number}} from {{org_name}}',
    'Dear {{contact_person}},\n\nPlease find invoice {{invoice_number}} dated {{invoice_date}} for {{invoice_total}} (balance {{invoice_balance}}). Payment is due by {{due_date}}.\n\nRegards,\n{{org_name}}\n{{org_contact}}\n\nView / pay online: {{invoice_link}}');
  tpl('Payment receipt', 'whatsapp', 'receipt', null,
    'Hello {{contact_person}}, we have received your payment of {{payment_amount}} on {{payment_date}} against invoice {{invoice_number}}. Balance pending: {{invoice_balance}}. Thank you! - {{org_name}}');
  tpl('Payment receipt', 'email', 'receipt', 'Payment received - {{invoice_number}}',
    'Dear {{contact_person}},\n\nThank you. We have received {{payment_amount}} on {{payment_date}} ({{payment_mode}}) against invoice {{invoice_number}}.\nBalance pending: {{invoice_balance}}.\n\nRegards,\n{{org_name}}\n{{org_contact}}');
  return roleId;
}

// New organisation with its creator as admin. `org` = first billing entity (only name is needed; the rest can be filled later).
export function createTenant(userId, name, org = {}) {
  return tx(() => {
    const tid = run('INSERT INTO tenants (name, invite_code, created_by) VALUES (?, ?, ?)', name, newInviteCode(), userId).lastInsertRowid;
    const roleId = createTenantDefaults(tid);
    run("INSERT INTO memberships (tenant_id, user_id, role, role_id, status, decided_at, decided_by) VALUES (?, ?, 'admin', ?, 'approved', CURRENT_TIMESTAMP, ?)", tid, userId, roleId.Admin, userId);
    if (!get('SELECT role_id FROM users WHERE id = ?', userId)?.role_id) run('UPDATE users SET role_id = ? WHERE id = ?', roleId.Admin, userId); // legacy fallback only
    const keys = ['name', ...Object.keys(org).filter((k) => k !== 'name')];
    const vals = { ...org, name: org.name || name };
    const orgId = run(`INSERT INTO organisations (tenant_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, tid, ...keys.map((k) => vals[k])).lastInsertRowid;
    return { tid, orgId, roleId };
  });
}

export function seedIfEmpty({ saveInvoice, refreshPaid, hashPassword }) {
  if (get('SELECT COUNT(*) AS n FROM tenants').n || process.env.SEED_DEMO === '0') return;

  const adminId = run('INSERT INTO users (name, email, password_hash) VALUES (?,?,?)', 'Admin', 'admin@example.com', hashPassword('admin123')).lastInsertRowid;
  const D = DUMMY_COMPANY;
  const { tid, orgId: org } = createTenant(adminId, D.name, { name: D.name, address: D.address, state: D.state, state_code: D.state_code,
    gst_number: D.gst_number, pan_number: D.pan_number, email: D.email, contact: D.contact, bank_details: D.bank_details, upi_id: D.upi_id,
    terms: D.terms, footer_note: D.footer_note, logo: D.logo, signature: D.signature });
  const clients = [
    ['TATA MOTORS PASSENGER VEHICLES LIMITED', 'No.67, Tata Motors limited, G N Chetty Road, Chennai, Tamil Nadu, 600017', '33AAACT2727Q1Z3', null, '9718012384'],
    ['Punjab National Bank', 'SCF MF-21-22, PNB, Sector-12, Karnal, Haryana, 132001', '06AAACP0165G4ZQ', null, '9718012384'],
    ['K RAHEJA CORP REAL ESTATE PRIVATE LIMITED', 'Raheja Towers, Opp SIDBI Bandra Kurla Complex, Mumbai, Maharashtra, 400051', '27AABCF1838M1ZF', 'mahima.handysolver@gmail.com', '8383950371'],
    ['ZOHO CORPORATION PRIVATE LIMITED', 'Plot No 140,151, Estancia IT Park, GST Road, Vallancherry, Kancheepuram, Tamil Nadu, 603202', '33AAACZ4322M1ZA', 'rinki.handysolver@gmail.com', '9718012384'],
    ['SARA TEXTILES LTD', 'Village Bhatian, Pargana Palasi, Tehsil Nalagarh, Solan, Himachal Pradesh, 174101', '02AAHCS9602C2ZQ', 'rinki.handysolver@gmail.com', '9718012384'],
  ].map(([name, address, gst, email, mobile]) => {
    const code = gst.slice(0, 2);
    return run('INSERT INTO clients (tenant_id, name, address, gst_number, state_code, email, mobile, contact_person) VALUES (?,?,?,?,?,?,?,?)', tid,
      name, address, gst, code, email, mobile, name).lastInsertRowid;
  });

  const products = [
    ['Website Development', '4502', 'Website development', 45000, 18],
    ['Web Design', '4507', 'New web design', 45000, 18],
    ['Enterprise Solution', '5463', 'Enterprise software solution', 560000, 18],
  ].map(([name, sac, description, price, tax]) =>
    run('INSERT INTO service_products (tenant_id, name, sac_number, description, price, tax) VALUES (?,?,?,?,?,?)', tid, name, sac, description, price, tax).lastInsertRowid);

  // Sample invoices spread over recent months, so the dashboard has something to show.
  const now = new Date().toISOString().slice(0, 10);
  const line = (i, qty = 1, disc = 0) => ({ service_product_id: products[i], quantity: qty, discount_percent: disc,
    ...get('SELECT sac_number, description, price, tax FROM service_products WHERE id = ?', products[i]) });
  const samples = [
    // [client idx, days ago, due in days, items, paid fraction]
    [3, 170, 7, [line(0), line(2, 1, 2)], 1],
    [2, 140, 7, [line(2)], 1],
    [0, 105, 15, [line(0, 2)], 0.5],
    [4, 75, 7, [line(1)], 0],
    [1, 45, 15, [line(1, 1, 5)], 0.4],
    [3, 20, 15, [line(0)], 0],
    [2, 6, 15, [line(1, 2)], 0],
  ];
  for (const [ci, ago, due, items, frac] of samples) {
    const date = addDays(now, -ago);
    const id = saveInvoice(tid, { invoice_type: 'tax', invoice_date: date, due_date: addDays(date, due), organisation_id: org,
      client_id: clients[ci], items, tds_percent: ci === 2 ? 10 : 0 }, adminId);
    const inv = get('SELECT net_amount FROM invoices WHERE id = ?', id);
    if (frac) {
      run('INSERT INTO payments (invoice_id, amount, paid_on, mode, created_by) VALUES (?,?,?,?,?)',
        id, Math.round(inv.net_amount * frac * 100) / 100, addDays(date, Math.min(ago, 10)), 'Bank Transfer', adminId);
      refreshPaid(id);
    }
  }
  saveInvoice(tid, { invoice_type: 'proforma', invoice_date: addDays(now, -2), due_date: addDays(now, 5), organisation_id: org,
    client_id: clients[0], items: [line(0)] }, adminId);

  console.log('Seeded demo data. Login: admin@example.com / admin123  (change this password after first login)');
}

// Static management (platform) login; override with MANAGEMENT_EMAIL / MANAGEMENT_PASSWORD before first start.
export function ensureManagement(hashPassword) {
  if (get('SELECT 1 AS x FROM users WHERE is_management = 1')) return;
  const email = (process.env.MANAGEMENT_EMAIL || 'management@invocing.local').toLowerCase();
  const u = get('SELECT id FROM users WHERE email = ?', email);
  if (u) run('UPDATE users SET is_management = 1 WHERE id = ?', u.id);
  else run('INSERT INTO users (name, email, password_hash, is_management) VALUES (?, ?, ?, 1)', 'Management', email, hashPassword(process.env.MANAGEMENT_PASSWORD || 'manage123'));
  console.log(`Management login: ${email}${u ? '' : ' / ' + (process.env.MANAGEMENT_PASSWORD ? '(MANAGEMENT_PASSWORD)' : 'manage123')}`);
}

// Management accounts get their own workspace (an organisation they admin) so they can use Invoicing and Tasks too.
// It is flagged is_platform so it never shows up among the customer organisations management controls.
export function ensureManagementWorkspace() {
  for (const u of all("SELECT id, name FROM users WHERE is_management = 1 AND id NOT IN (SELECT user_id FROM memberships WHERE status IN ('approved', 'pending'))")) {
    const { tid } = createTenant(u.id, 'Management workspace');
    run('UPDATE tenants SET is_platform = 1 WHERE id = ?', tid);
    console.log(`Created management workspace for ${u.name}`);
  }
}

// One-time: reduce every organisation to Admin + Team member. Users on any other role become Team members.
export function normalizeRoles() {
  if (getSetting('roles_v3', false)) return;
  tx(() => {
    for (const { id: tid } of all('SELECT id FROM tenants')) {
      const roles = all('SELECT * FROM roles WHERE tenant_id = ?', tid);
      let admin = roles.find((r) => JSON.parse(r.permissions).includes('*'));
      if (admin && admin.name !== 'Admin') run("UPDATE roles SET name = 'Admin' WHERE id = ?", admin.id);
      if (!admin) admin = { id: run("INSERT INTO roles (tenant_id, name, permissions) VALUES (?, 'Admin', '[\"*\"]')", tid).lastInsertRowid };
      let team = roles.find((r) => r.name === DEFAULT_MEMBER_ROLE);
      if (team) run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify(TEAM_MEMBER), team.id);
      else team = { id: run('INSERT INTO roles (tenant_id, name, permissions) VALUES (?, ?, ?)', tid, DEFAULT_MEMBER_ROLE, JSON.stringify(TEAM_MEMBER)).lastInsertRowid };
      const others = roles.filter((r) => r.id !== admin.id && r.id !== team.id).map((r) => r.id);
      for (const rid of others) {
        run('UPDATE users SET role_id = ? WHERE role_id = ?', team.id, rid);
        run('DELETE FROM roles WHERE id = ?', rid);
      }
      run("UPDATE memberships SET role = CASE WHEN user_id IN (SELECT id FROM users WHERE role_id = ?) THEN 'admin' ELSE 'member' END WHERE tenant_id = ? AND status = 'approved'", admin.id, tid);
    }
    setSetting('roles_v3', true);
  });
}