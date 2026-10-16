import { all, get, run } from './db.js';
import { PERMISSIONS } from './index.js';
import { DUMMY_COMPANY } from './dummy.js';

const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function seedIfEmpty({ saveInvoice, refreshPaid, hashPassword }) {
  if (get('SELECT COUNT(*) AS n FROM roles').n) return;

  const view = Object.entries(PERMISSIONS).flatMap(([m, a]) => (a.includes('view') && !['users', 'roles', 'settings'].includes(m) ? [`${m}.view`] : []));
  const accountant = [
    'dashboard.view', 'dashboard.export', 'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.export',
    'payments.create', 'clients.view', 'clients.create', 'clients.edit', 'products.view', 'products.create', 'products.edit',
    'reminders.view', 'reminders.send', 'templates.view', 'templates.create', 'templates.edit',
  ];
  const roleId = {};
  for (const [name, perms] of [['Admin', ['*']], ['Accountant', accountant], ['Viewer', view]]) {
    roleId[name] = run('INSERT INTO roles (name, permissions) VALUES (?, ?)', name, JSON.stringify(perms)).lastInsertRowid;
  }
  const adminId = run('INSERT INTO users (name, email, password_hash, role_id) VALUES (?,?,?,?)',
    'Admin', 'admin@example.com', hashPassword('admin123'), roleId.Admin).lastInsertRowid;

  const D = DUMMY_COMPANY;
  const org = run(`INSERT INTO organisations (name, address, state, state_code, gst_number, pan_number, email, contact, bank_details, upi_id, terms, footer_note, logo, signature)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, D.name, D.address, D.state, D.state_code, D.gst_number, D.pan_number, D.email, D.contact,
    D.bank_details, D.upi_id, D.terms, D.footer_note, D.logo, D.signature).lastInsertRowid;

  const clients = [
    ['TATA MOTORS PASSENGER VEHICLES LIMITED', 'No.67, Tata Motors limited, G N Chetty Road, Chennai, Tamil Nadu, 600017', '33AAACT2727Q1Z3', null, '9718012384'],
    ['Punjab National Bank', 'SCF MF-21-22, PNB, Sector-12, Karnal, Haryana, 132001', '06AAACP0165G4ZQ', null, '9718012384'],
    ['K RAHEJA CORP REAL ESTATE PRIVATE LIMITED', 'Raheja Towers, Opp SIDBI Bandra Kurla Complex, Mumbai, Maharashtra, 400051', '27AABCF1838M1ZF', 'mahima.handysolver@gmail.com', '8383950371'],
    ['ZOHO CORPORATION PRIVATE LIMITED', 'Plot No 140,151, Estancia IT Park, GST Road, Vallancherry, Kancheepuram, Tamil Nadu, 603202', '33AAACZ4322M1ZA', 'rinki.handysolver@gmail.com', '9718012384'],
    ['SARA TEXTILES LTD', 'Village Bhatian, Pargana Palasi, Tehsil Nalagarh, Solan, Himachal Pradesh, 174101', '02AAHCS9602C2ZQ', 'rinki.handysolver@gmail.com', '9718012384'],
  ].map(([name, address, gst, email, mobile]) => {
    const code = gst.slice(0, 2);
    return run('INSERT INTO clients (name, address, gst_number, state_code, email, mobile, contact_person) VALUES (?,?,?,?,?,?,?)',
      name, address, gst, code, email, mobile, name).lastInsertRowid;
  });

  const products = [
    ['Website Development', '4502', 'Website development', 45000, 18],
    ['Web Design', '4507', 'New web design', 45000, 18],
    ['Enterprise Solution', '5463', 'Enterprise software solution', 560000, 18],
  ].map(([name, sac, description, price, tax]) =>
    run('INSERT INTO service_products (name, sac_number, description, price, tax) VALUES (?,?,?,?,?)', name, sac, description, price, tax).lastInsertRowid);

  const tpl = (name, channel, kind, subject, body) =>
    run('INSERT INTO message_templates (name, channel, kind, subject, body) VALUES (?,?,?,?,?)', name, channel, kind, subject, body);
  tpl('Payment reminder (all pending)', 'whatsapp', 'reminder', null,
    'Hello {{contact_person}},\n\nThis is a friendly reminder from {{org_name}}. You have {{pending_count}} pending invoice(s) totalling {{total_pending}}:\n\n{{invoice_list}}\n\nKindly arrange the payment at the earliest. Please ignore if already paid.\n\nThank you,\n{{org_name}} {{org_contact}}');
  tpl('Payment reminder (all pending)', 'email', 'reminder', 'Payment reminder - {{total_pending}} pending',
    'Dear {{contact_person}},\n\nThis is a gentle reminder that {{pending_count}} invoice(s) from {{org_name}} are pending, totalling {{total_pending}}:\n\n{{invoice_list}}\n\nKindly arrange the payment at the earliest. If you have already paid, please share the payment details so we can update our records.\n\nRegards,\n{{org_name}}\n{{org_contact}}');
  tpl('Overdue invoice notice', 'whatsapp', 'reminder', null,
    'Hello {{contact_person}}, invoice {{invoice_number}} of {{invoice_total}} was due on {{due_date}} ({{days_overdue}} days ago). Balance pending: {{invoice_balance}}. Kindly pay at the earliest. - {{org_name}}');
  tpl('Send invoice', 'whatsapp', 'invoice', null,
    'Hello {{contact_person}}, please find invoice {{invoice_number}} dated {{invoice_date}} for {{invoice_total}}. Due date: {{due_date}}. Thank you - {{org_name}}');
  tpl('Send invoice', 'email', 'invoice', 'Invoice {{invoice_number}} from {{org_name}}',
    'Dear {{contact_person}},\n\nPlease find invoice {{invoice_number}} dated {{invoice_date}} for {{invoice_total}} (balance {{invoice_balance}}). Payment is due by {{due_date}}.\n\nRegards,\n{{org_name}}\n{{org_contact}}');

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
    const id = saveInvoice({ invoice_type: 'tax', invoice_date: date, due_date: addDays(date, due), organisation_id: org,
      client_id: clients[ci], items, tds_percent: ci === 2 ? 10 : 0 }, adminId);
    const inv = get('SELECT net_amount FROM invoices WHERE id = ?', id);
    if (frac) {
      run('INSERT INTO payments (invoice_id, amount, paid_on, mode, created_by) VALUES (?,?,?,?,?)',
        id, Math.round(inv.net_amount * frac * 100) / 100, addDays(date, Math.min(ago, 10)), 'Bank Transfer', adminId);
      refreshPaid(id);
    }
  }
  saveInvoice({ invoice_type: 'proforma', invoice_date: addDays(now, -2), due_date: addDays(now, 5), organisation_id: org,
    client_id: clients[0], items: [line(0)] }, adminId);

  console.log('Seeded demo data. Login: admin@example.com / admin123  (change this password after first login)');
}
