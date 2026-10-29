import ExcelJS from 'exceljs';
import { all, get, run, tx, getSetting, setSetting } from './db.js';
import { r2, financialYear } from './calc.js';
import { logAct } from './activity.js';

const iso = (d) => d.toISOString().slice(0, 10);
const todayStr = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// n periods after `start`, clamped to month end (31 Jan + 1 month = 28/29 Feb, and next time back to 31 Mar)
export function periodAfter(start, freq, n) {
  if (freq === 'weekly') return addDays(start, 7 * n);
  const step = { monthly: 1, quarterly: 3, yearly: 12 }[freq] || 1;
  const d = new Date(start + 'T00:00:00Z');
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step * n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return iso(t);
}

export async function ensureDefaults() {
  // Older "send invoice" templates get the online-view link appended once.
  (await run(`UPDATE message_templates SET body = body || char(10) || char(10) || 'View / pay online: {{invoice_link}}'
       WHERE kind = 'invoice' AND body NOT LIKE '%invoice_link%'`));
  for (const { id: tid } of (await all('SELECT id FROM tenants'))) {
    if ((await get("SELECT id FROM message_templates WHERE kind = 'receipt' AND tenant_id = ?", tid))) continue;
    (await run(`INSERT INTO message_templates (tenant_id, name, channel, kind, subject, body) VALUES (?,?,?,?,?,?)`, tid, 'Payment receipt', 'whatsapp', 'receipt', null,
      'Hello {{contact_person}}, we have received your payment of {{payment_amount}} on {{payment_date}} against invoice {{invoice_number}}. Balance pending: {{invoice_balance}}. Thank you! - {{org_name}}'));
    (await run(`INSERT INTO message_templates (tenant_id, name, channel, kind, subject, body) VALUES (?,?,?,?,?,?)`, tid, 'Payment receipt', 'email', 'receipt', 'Payment received - {{invoice_number}}',
      'Dear {{contact_person}},\n\nThank you. We have received {{payment_amount}} on {{payment_date}} ({{payment_mode}}) against invoice {{invoice_number}}.\nBalance pending: {{invoice_balance}}.\n\nRegards,\n{{org_name}}\n{{org_contact}}'));
  }
}

export async function ensureRolePerms() {
  // Accountant existed before the newer modules; give it sensible defaults once.
  const extra = ['recurring.view', 'recurring.create', 'recurring.edit', 'expenses.view', 'expenses.create', 'expenses.edit', 'gst.view', 'gst.export'];
  if (!(await getSetting('perms_v2', false))) {
    for (const r of (await all("SELECT id, permissions FROM roles WHERE name = 'Accountant'"))) {
      const p = JSON.parse(r.permissions);
      (await run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify([...new Set([...p, ...extra])]), r.id));
    }
  }
  (await setSetting('perms_v2', true));
}

export function init({ api, need, wrap, fail, crud, saveInvoice, invoiceDetail, refreshPaid, PREFIX }) {
  /* ------------------------------------------------ recurring invoices */
  const recRow = (r) => {
    const items = JSON.parse(r.items_json);
    const est = items.reduce((s, i) => s + (i.price * i.quantity * (1 - (i.discount_percent || 0) / 100)) * (1 + (i.tax || 0) / 100), 0);
    return { ...r, items_json: undefined, item_count: items.length, estimate: r2(est) };
  };
  api.get('/recurring', need('recurring.view'), wrap(async (req) =>
    (await all(`SELECT r.*, c.name AS client_name, o.name AS org_name FROM recurring_invoices r
         JOIN clients c ON c.id = r.client_id JOIN organisations o ON o.id = r.organisation_id WHERE r.tenant_id = ? ORDER BY r.active DESC, r.next_run`, req.user.tid)).map(recRow)));

  api.post('/recurring', need('recurring.create'), wrap(async (req) => {
    const { source_invoice_id, frequency, next_run, end_date, due_days } = req.body;
    if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(frequency)) throw fail(400, 'Pick a frequency');
    const inv = (await invoiceDetail(source_invoice_id, req.user.tid));
    const start = next_run || periodAfter(inv.invoice_date, frequency, 1);
    const items = inv.items.map((i) => ({ service_product_id: i.service_product_id, sac_number: i.sac_number, description: i.description, price: i.price, quantity: i.quantity, discount_percent: i.discount_percent, tax: i.tax }));
    const id = (await run(`INSERT INTO recurring_invoices (tenant_id, created_by, organisation_id, client_id, invoice_type, frequency, start_date, next_run, end_date, due_days, tds_percent, notes, items_json, source_invoice_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, req.user.tid, req.user.id, inv.organisation_id, inv.client_id, inv.invoice_type, frequency, start, start, end_date || null,
      +due_days >= 0 ? +due_days : 7, inv.tds_percent, inv.notes, JSON.stringify(items), inv.id)).lastInsertRowid;
    (await run('UPDATE recurring_invoices SET gst_applied = ?, pay_qr = ?, pay_upi = ?, pay_bank = ? WHERE id = ?', inv.gst_applied ? 1 : 0, inv.pay_qr, inv.pay_upi, inv.pay_bank, id));
    (await logAct(req.user, 'create', 'recurring', id, `${frequency} schedule for ${inv.client_name} (from ${inv.invoice_number})`));
    return { id };
  }));
  api.put('/recurring/:id', need('recurring.edit'), wrap(async (req) => {
    const r = (await get('SELECT * FROM recurring_invoices WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid));
    if (!r) throw fail(404, 'Not found');
    const b = req.body;
    (await run('UPDATE recurring_invoices SET frequency = ?, next_run = ?, end_date = ?, due_days = ?, active = ? WHERE id = ?',
      b.frequency ?? r.frequency, b.next_run ?? r.next_run, b.end_date === undefined ? r.end_date : b.end_date || null,
      b.due_days ?? r.due_days, b.active === undefined ? r.active : +!!b.active, r.id));
    (await logAct(req.user, b.active === undefined ? 'update' : b.active ? 'resume' : 'pause', 'recurring', r.id, `schedule #${r.id}`));
    return { ok: true };
  }));
  api.delete('/recurring/:id', need('recurring.delete'), wrap(async (req) => {
    (await run('DELETE FROM recurring_invoices WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid));
    (await logAct(req.user, 'delete', 'recurring', +req.params.id, `schedule #${req.params.id}`));
    return { ok: true };
  }));
  api.post('/recurring/:id/run', need('recurring.edit'), wrap(async (req) => {
    const r = (await get('SELECT * FROM recurring_invoices WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid));
    if (!r) throw fail(404, 'Not found');
    return { id: (await runOne(r, todayStr(), req.user)) };
  }));

  async function runOne(r, date, user) {
    const id = (await saveInvoice(r.tenant_id, {
      invoice_type: r.invoice_type, invoice_date: date, due_date: addDays(date, r.due_days ?? 7), organisation_id: r.organisation_id,
      client_id: r.client_id, items: JSON.parse(r.items_json), tds_percent: r.tds_percent, notes: r.notes,
      gst_applied: r.gst_applied, pay_qr: r.pay_qr, pay_upi: r.pay_upi, pay_bank: r.pay_bank,
    }, user?.id ?? r.created_by));
    const count = r.run_count + 1;
    const next = periodAfter(r.start_date, r.frequency, count);
    const finished = r.end_date && next > r.end_date;
    (await run('UPDATE recurring_invoices SET run_count = ?, next_run = ?, last_invoice_id = ?, last_run_at = CURRENT_TIMESTAMP, active = ? WHERE id = ?',
      count, next, id, finished ? 0 : r.active, r.id));
    const inv = (await get('SELECT invoice_number, client_name FROM invoices WHERE id = ?', id));
    (await logAct(user || null, user ? 'generate' : 'auto-create', 'invoice', id, `${inv.invoice_number} for ${inv.client_name} (recurring #${r.id})`, r.tenant_id));
    return id;
  }
  async function runDue() {
    const t = todayStr();
    for (const r of (await all('SELECT * FROM recurring_invoices WHERE active = 1 AND next_run <= ?', t))) {
      let cur = r;
      for (let i = 0; i < 12 && cur.active && cur.next_run <= t; i++) { // catch up missed runs, oldest first
        try { (await runOne(cur, cur.next_run, null)); } catch (e) { console.error('recurring failed', r.id, e.message); break; }
        cur = (await get('SELECT * FROM recurring_invoices WHERE id = ?', r.id));
      }
    }
  }
  // hourly on a normal server; on Vercel there are no background timers, Vercel Cron calls /api/cron/recurring instead
  if (!process.env.VERCEL) {
    const runDueSafe = () => runDue().catch((e) => console.error('recurring run failed', e.message));
    setTimeout(runDueSafe, 3000);
    setInterval(runDueSafe, 60 * 60 * 1000).unref();
  }

  /* ------------------------------------------------ credit notes */
  api.post('/invoices/:id/credit-notes', need('invoices.create'), wrap(async (req) => {
    const inv = (await invoiceDetail(req.params.id, req.user.tid));
    if (inv.invoice_type !== 'tax') throw fail(400, 'Credit notes apply to tax invoices');
    const taxable = r2(req.body.taxable);
    const rate = +req.body.tax_rate >= 0 ? +req.body.tax_rate : inv.items[0]?.tax || 0;
    if (!(taxable > 0)) throw fail(400, 'Enter the credit amount (before GST)');
    const gst = r2((taxable * rate) / 100), total = r2(taxable + gst);
    if (total > r2(inv.net_amount - inv.credit_amount) + 0.005) throw fail(400, 'Credit is more than the invoice value that is left');
    const date = req.body.note_date || todayStr(), fy = financialYear(date);
    const id = (await tx(async () => {
      const n = ((await get('SELECT MAX(series_int) AS m FROM credit_notes WHERE organisation_id = ? AND fy = ?', inv.organisation_id, fy))?.m || 0) + 1;
      const cgst = inv.intra ? r2(gst / 2) : 0, sgst = inv.intra ? r2(gst - cgst) : 0, igst = inv.intra ? 0 : gst;
      const cid = (await run(`INSERT INTO credit_notes (tenant_id, created_by, number, fy, series_int, note_date, invoice_id, organisation_id, reason, taxable, tax_rate, igst, cgst, sgst, total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, req.user.tid, req.user.id, `CN/${fy}/${String(n).padStart(4, '0')}`, fy, n, date, inv.id, inv.organisation_id,
        req.body.reason || null, taxable, rate, igst, cgst, sgst, total)).lastInsertRowid;
      (await refreshPaid(inv.id));
      return cid;
    }));
    const cn = (await get('SELECT number FROM credit_notes WHERE id = ?', id));
    (await logAct(req.user, 'create', 'credit note', id, `${cn.number} of ₹${total} against ${inv.invoice_number}`));
    return { id };
  }));
  api.get('/credit-notes/:id', need('invoices.view'), wrap(async (req) => {
    const c = (await get('SELECT * FROM credit_notes WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid));
    if (!c) throw fail(404, 'Not found');
    return { ...c, invoice: (await invoiceDetail(c.invoice_id, req.user.tid)) };
  }));
  api.delete('/credit-notes/:id', need('invoices.delete'), wrap(async (req) => {
    const c = (await get('SELECT * FROM credit_notes WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid));
    if (!c) return { ok: true };
    (await tx(async () => { (await run('DELETE FROM credit_notes WHERE id = ?', c.id)); (await refreshPaid(c.invoice_id)); }));
    (await logAct(req.user, 'delete', 'credit note', c.id, c.number));
    return { ok: true };
  }));

  /* ------------------------------------------------ expenses (generic CRUD) */
  crud('expenses', 'expenses', ['date', 'category', 'vendor', 'amount', 'notes'], { order: 'date DESC, id DESC' });

  /* ------------------------------------------------ activity log */
  api.get('/activity', need('activity.view'), wrap(async (req) => {
    const w = ['tenant_id = ?'], p = [req.user.tid];
    if (req.query.entity) { w.push('entity = ?'); p.push(req.query.entity); }
    if (req.query.user_id) { w.push('user_id = ?'); p.push(req.query.user_id); }
    return (await all(`SELECT * FROM activity_log WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT 300`, ...p));
  }));

  /* ------------------------------------------------ reminder rules + queue */
  const DEFAULT_RULES = [-3, 0, 3, 7, 15];
  api.get('/reminders/rules', need('reminders.view'), wrap(async (req) => ({ rules: (await getSetting('reminder_rules', DEFAULT_RULES, req.user.tid)) })));
  api.put('/reminders/rules', need('reminders.send'), wrap(async (req) => {
    const rules = [...new Set((req.body.rules || []).map(Number).filter((n) => Number.isInteger(n) && n >= -60 && n <= 365))].sort((a, b) => a - b);
    if (!rules.length) throw fail(400, 'Add at least one day');
    (await setSetting('reminder_rules', rules, req.user.tid));
    (await logAct(req.user, 'update', 'reminder rules', null, rules.join(', ')));
    return { rules };
  }));
  api.get('/reminders/queue', need('reminders.view'), wrap(async (req) => (await reminderQueue(req.user.tid))));

  return { reminderQueue, runDue };
  async function reminderQueue(tid) {
    const rules = (await getSetting('reminder_rules', DEFAULT_RULES, tid)).sort((a, b) => a - b);
    const t = todayStr(), out = [];
    const rows = (await all(`SELECT i.id, i.invoice_number, i.due_date, i.balance_amount, i.client_id, c.name AS client_name, c.mobile, c.email
      FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.invoice_type = 'tax' AND i.balance_amount > 0.005 AND i.due_date IS NOT NULL AND i.tenant_id = ?`, tid));
    for (const r of rows) {
      const diff = daysBetween(r.due_date, t); // >0 = days overdue, <0 = days left
      const rule = Math.max(...rules.filter((x) => x <= diff), -Infinity);
      if (rule === -Infinity) continue;
      if ((await get('SELECT 1 AS x FROM reminder_log WHERE invoice_id = ? AND rule = ? AND tenant_id = ?', r.id, rule, tid))) continue;
      out.push({ ...r, diff, rule, label: rule < 0 ? `${-rule} day(s) before due` : rule === 0 ? 'Due date' : `${rule} day(s) overdue` });
    }
    return out.sort((a, b) => b.diff - a.diff);
  }
}

/* ------------------------------------------------ GST report (GSTR-1 style) */
export function registerGst({ api, need, wrap }) {
  const report = async (tid, from, to) => {
    const rows = (await all(`SELECT i.id, i.invoice_number, i.invoice_date, i.client_name, i.client_gst, i.place_of_supply, it.tax AS rate,
        SUM(it.selling_amount) AS taxable, SUM(it.igst) AS igst, SUM(it.cgst) AS cgst, SUM(it.sgst) AS sgst, SUM(it.total_amount) AS total
      FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
      WHERE i.tenant_id = ? AND i.invoice_type = 'tax' AND i.gst_applied = 1 AND i.invoice_date BETWEEN ? AND ? GROUP BY i.id, it.tax ORDER BY i.invoice_date, i.id`, tid, from, to));
    const isB2b = (r) => (r.client_gst || '').trim().length >= 15;
    const notes = (await all(`SELECT n.number, n.note_date, n.reason, n.taxable, n.tax_rate AS rate, n.igst, n.cgst, n.sgst, n.total,
        i.invoice_number, i.invoice_date, i.client_name, i.client_gst
      FROM credit_notes n JOIN invoices i ON i.id = n.invoice_id WHERE i.tenant_id = ? AND n.note_date BETWEEN ? AND ? ORDER BY n.note_date, n.id`, tid, from, to));
    const hsn = (await all(`SELECT it.sac_number AS sac, it.tax AS rate, SUM(it.quantity) AS qty, SUM(it.selling_amount) AS taxable,
        SUM(it.igst) AS igst, SUM(it.cgst) AS cgst, SUM(it.sgst) AS sgst, SUM(it.total_amount) AS total
      FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE i.tenant_id = ? AND i.invoice_type = 'tax' AND i.gst_applied = 1 AND i.invoice_date BETWEEN ? AND ?
      GROUP BY it.sac_number, it.tax ORDER BY it.sac_number`, tid, from, to));
    const sum = (list, k) => r2(list.reduce((s, r) => s + (r[k] || 0), 0));
    const totals = (list) => ({ taxable: sum(list, 'taxable'), cgst: sum(list, 'cgst'), sgst: sum(list, 'sgst'), igst: sum(list, 'igst'), total: sum(list, 'total') });
    const b2b = rows.filter(isB2b), b2c = rows.filter((r) => !isB2b(r));
    const cn = totals(notes);
    const all_ = totals(rows);
    return {
      from, to, b2b, b2c, notes, hsn,
      totals: { b2b: totals(b2b), b2c: totals(b2c), credit: cn, invoices: all_,
        net: { taxable: r2(all_.taxable - cn.taxable), cgst: r2(all_.cgst - cn.cgst), sgst: r2(all_.sgst - cn.sgst), igst: r2(all_.igst - cn.igst), total: r2(all_.total - cn.total) } },
    };
  };
  const range = (q) => {
    const d = new Date(), from = q.from || iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)));
    return [from, q.to || iso(new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 0)))];
  };
  api.get('/gst/report', need('gst.view'), wrap(async (req) => (await report(req.user.tid, ...range(req.query)))));
  api.get('/gst/export.xlsx', need('gst.export'), async (req, res) => {
    try {
      const [from, to] = range(req.query), d = (await report(req.user.tid, from, to));
      const wb = new ExcelJS.Workbook();
      const sheet = (name, cols, rows) => {
        const ws = wb.addWorksheet(name);
        ws.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width: width || 14, style: fmt ? { numFmt: fmt } : {} }));
        ws.addRows(rows);
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF262A3A' } };
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        return ws;
      };
      const money = '#,##0.00';
      const invCols = [['Invoice No', 'invoice_number', 22], ['Date', 'invoice_date', 12], ['Client', 'client_name', 30], ['GSTIN', 'client_gst', 18], ['Place of supply', 'place_of_supply', 20],
        ['Rate %', 'rate', 8], ['Taxable', 'taxable', 14, money], ['IGST', 'igst', 12, money], ['CGST', 'cgst', 12, money], ['SGST', 'sgst', 12, money], ['Invoice value', 'total', 14, money]];
      const s = sheet('Summary', [['Section', 'name', 30], ['Taxable', 'taxable', 16, money], ['CGST', 'cgst', 14, money], ['SGST', 'sgst', 14, money], ['IGST', 'igst', 14, money], ['Total', 'total', 16, money]], [
        { name: `Period ${from} to ${to}` }, { name: 'B2B invoices', ...d.totals.b2b }, { name: 'B2C invoices', ...d.totals.b2c },
        { name: 'Credit notes (less)', ...d.totals.credit }, { name: 'NET LIABILITY', ...d.totals.net }]);
      s.getRow(6).font = { bold: true };
      sheet('B2B', invCols, d.b2b);
      sheet('B2C', invCols, d.b2c);
      sheet('Credit Notes', [['Note No', 'number', 20], ['Date', 'note_date', 12], ['Against invoice', 'invoice_number', 22], ['Client', 'client_name', 28], ['GSTIN', 'client_gst', 18], ['Reason', 'reason', 24],
        ['Rate %', 'rate', 8], ['Taxable', 'taxable', 14, money], ['IGST', 'igst', 12, money], ['CGST', 'cgst', 12, money], ['SGST', 'sgst', 12, money], ['Total', 'total', 14, money]], d.notes);
      sheet('HSN Summary', [['SAC / HSN', 'sac', 14], ['Rate %', 'rate', 8], ['Quantity', 'qty', 10], ['Taxable', 'taxable', 14, money], ['IGST', 'igst', 12, money], ['CGST', 'cgst', 12, money], ['SGST', 'sgst', 12, money], ['Total', 'total', 14, money]], d.hsn);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="GST_report_${from}_to_${to}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Export failed' }); }
  });
}
