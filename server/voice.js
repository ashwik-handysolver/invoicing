// Voice / text assistant: Claude turns a spoken command (Hindi, English or Hinglish) into one of a fixed set of
// app actions. Reads run immediately; every change is held as a pending action until the user confirms it.
// All actions run as the signed-in user: same permissions, same organisation scope as the normal API.
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, ApiError as GeminiError } from '@google/genai';
import { all, get, run, tx } from './db.js';
import { r2, calcInvoice } from './calc.js';
import { MODULES, ALL_MODULES, tenantModules } from './modules.js';
import { deleteTenant } from './orgs.js';
import { logAct } from './activity.js';
import { TASK_PRIORITIES, TASK_STATUSES, taskScope, assignable, assignablePeople, assignedToSql, isAssignee, withAssignees, setAssignees } from './tasks.js';

// Provider: VOICE_PROVIDER=claude|gemini, or picked from whichever key is set (Claude first).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const PROVIDER = process.env.VOICE_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'claude' : GEMINI_KEY() ? 'gemini' : 'claude');
const MODEL = process.env.VOICE_MODEL || (PROVIDER === 'gemini' ? 'gemini-3.5-flash' : 'claude-opus-5-5');
// Gemini: if a model is busy (503), retired (404) or out of free quota (429), try the next one.
const GEMINI_MODELS = [...new Set([MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
const NOT_SET_UP = 'Voice is not set up: add GEMINI_API_KEY (free at aistudio.google.com) or ANTHROPIC_API_KEY on the server.';
const STATUS = ['active', 'inactive', 'on_hold'];
const PAGES = { dashboard: '#/dashboard', invoices: '#/invoices', payments: '#/payments', reminders: '#/reminders', clients: '#/clients',
  products: '#/products', expenses: '#/expenses', gst: '#/gst', recurring: '#/recurring', settings: '#/settings', tasks: '#/tasks', new_invoice: '#/invoices/new?type=tax',
  management_dashboard: '#/management', organisations: '#/organisations' };
const today = () => new Date().toISOString().slice(0, 10);
// Language of one message: Devanagari -> Hindi; Roman with common Hindi words -> Hinglish; otherwise English.
const HINGLISH = /\b(hai|hain|ho|kar|karo|kardo|kar do|karna|ka|ke|ki|ko|se|mein|pe|par|bhej|bhejo|bhejna|bhejdo|kya|kitna|kitne|kitni|baaki|baki|dikhao|kholo|batao|bata|wala|wale|aur|abhi|naya|nayi|sab|kuch|gaya|gayi|diya|liya|chahiye|nahi|haan|bhi|uska|uske|unka|mera|mujhe|hamara)\b/gi;
export const replyLang = (t) => {
  if (/[\u0900-\u097F]/.test(t)) return 'Hindi, written in Devanagari script';
  const words = (t.match(/[a-z]+/gi) || []).length, hindi = (t.match(HINGLISH) || []).length;
  return words && hindi / words >= 0.2 ? 'Hinglish (Hindi in Roman script, like the user)' : 'English';
};
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const ITEMS = { type: 'array', items: { type: 'object', properties: { product_id: { type: 'integer' }, description: { type: 'string' }, price: { type: 'number' }, quantity: { type: 'number' },
  tax: { type: 'number', description: 'GST %' }, discount_percent: { type: 'number' } } } };
const TOOLS = [
  { name: 'find_clients', description: 'Search clients of this organisation by name, contact person, mobile, email or GSTIN. Use before any client update to get the client_id. Empty query lists recent clients.',
    input_schema: obj({ query: { type: 'string' } }, ['query']) },
  { name: 'find_invoices', description: 'Search invoices. Filter by invoice number / client name text, client_id, or payment status. "overdue" = unpaid past due date.',
    input_schema: obj({ query: { type: 'string' }, client_id: { type: 'integer' }, status: { type: 'string', enum: ['unpaid', 'partial', 'paid', 'overdue', 'any'] } }) },
  { name: 'get_summary', description: 'Money summary for this financial year: billed, collected, outstanding, overdue, top pending clients.', input_schema: obj({}) },
  { name: 'compose_message', description: 'Send an invoice or a payment reminder to a client by email or WhatsApp. The app opens a ready-filled draft (from the message templates, with the invoice link) in the user\'s email app or WhatsApp, and the user presses send. Use kind "invoice" with invoice_id to send an invoice; kind "reminder" with client_id for a reminder about all pending invoices (or with invoice_id for one overdue invoice). Get ids with find_invoices / find_clients first.',
    input_schema: obj({ kind: { type: 'string', enum: ['invoice', 'reminder'] }, channel: { type: 'string', enum: ['email', 'whatsapp'] }, invoice_id: { type: 'integer' }, client_id: { type: 'integer' } }, ['kind', 'channel']) },
  { name: 'open_page', description: 'Open a page of the app for the user.', input_schema: obj({ page: { type: 'string', enum: Object.keys(PAGES) } }, ['page']) },
  { name: 'update_client', description: 'Change a client\'s details or status (active / inactive / on_hold). Needs client_id from find_clients. The user confirms before it is saved.',
    input_schema: obj({ client_id: { type: 'integer' }, status: { type: 'string', enum: STATUS }, name: { type: 'string' }, contact_person: { type: 'string' },
      mobile: { type: 'string' }, email: { type: 'string' }, address: { type: 'string' },
      then_compose: { type: 'object', description: 'Optional: after saving, open this email / WhatsApp draft (e.g. when the user just gave a missing email so the invoice can be sent).',
        properties: { kind: { type: 'string', enum: ['invoice', 'reminder'] }, channel: { type: 'string', enum: ['email', 'whatsapp'] }, invoice_id: { type: 'integer' } }, required: ['kind', 'channel'] } }, ['client_id']) },
  { name: 'create_client', description: 'Add a new client. The user confirms before it is saved.',
    input_schema: obj({ name: { type: 'string' }, contact_person: { type: 'string' }, mobile: { type: 'string' }, email: { type: 'string' }, gst_number: { type: 'string' } }, ['name']) },
  { name: 'record_payment', description: 'Record a payment received against a tax invoice (this is how an invoice becomes paid). Omit amount to pay the full balance. Needs invoice_id from find_invoices. The user confirms first.',
    input_schema: obj({ invoice_id: { type: 'integer' }, amount: { type: 'number' }, mode: { type: 'string', enum: ['UPI', 'Bank Transfer', 'Cash', 'Cheque', 'Card', 'Other'] },
      paid_on: { type: 'string', description: 'YYYY-MM-DD, default today' }, reference: { type: 'string' } }, ['invoice_id']) },
  { name: 'find_tasks', description: 'Search tasks by title / description text, assignee name, status or priority. "mine" = assigned to the user. Use before update_task to get the task_id. Empty input lists open tasks.',
    input_schema: obj({ query: { type: 'string' }, assignee: { type: 'string', description: 'person name, or "me"' }, status: { type: 'string', enum: [...TASK_STATUSES, 'open', 'overdue', 'any'] }, priority: { type: 'string', enum: TASK_PRIORITIES } }) },
  { name: 'find_people', description: 'List the team members tasks can be assigned to (id and name).', input_schema: obj({ query: { type: 'string' } }) },
  { name: 'create_task', description: 'Create a task and optionally assign it to one or more team members (assignees = user ids from find_people). The user becomes the assigner. The user confirms before it is saved.',
    input_schema: obj({ title: { type: 'string' }, description: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, priority: { type: 'string', enum: TASK_PRIORITIES },
      status: { type: 'string', enum: TASK_STATUSES }, assignees: { type: 'array', items: { type: 'integer' } } }, ['title']) },
  { name: 'update_task', description: 'Change a task. Only the person who assigned it (or an admin) can change anything; the assignee can only change status. Needs task_id from find_tasks. assignees replaces the whole list (pass [] to unassign everyone); add_assignees / remove_assignees change it. The user confirms first.',
    input_schema: obj({ task_id: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, priority: { type: 'string', enum: TASK_PRIORITIES },
      status: { type: 'string', enum: TASK_STATUSES }, assignees: { type: 'array', items: { type: 'integer' } }, add_assignees: { type: 'array', items: { type: 'integer' } },
      remove_assignees: { type: 'array', items: { type: 'integer' } } }, ['task_id']) },
  { name: 'find_products', description: 'List saved services / products (name, price, GST %, SAC) to use as invoice lines. Empty query lists them all.', input_schema: obj({ query: { type: 'string' } }) },
  { name: 'get_invoice', description: 'Full details of one invoice including its line items. Use before update_invoice.', input_schema: obj({ invoice_id: { type: 'integer' } }, ['invoice_id']) },
  { name: 'create_invoice', description: 'Create a tax invoice (default) or proforma for a client. Needs client_id from find_clients. Each item: product_id from find_products (price / GST / description come from it unless given) or a description with price. The user confirms first.',
    input_schema: obj({ client_id: { type: 'integer' }, invoice_type: { type: 'string', enum: ['tax', 'proforma'] }, invoice_date: { type: 'string', description: 'YYYY-MM-DD, default today' }, due_date: { type: 'string', description: 'YYYY-MM-DD' },
      gst_applied: { type: 'boolean', description: 'false = invoice without GST' }, notes: { type: 'string' }, items: ITEMS }, ['client_id', 'items']) },
  { name: 'update_invoice', description: 'Edit an invoice: dates, notes, GST on/off, or replace its line items (give the full new list). Needs invoice_id. The user confirms first.',
    input_schema: obj({ invoice_id: { type: 'integer' }, invoice_date: { type: 'string' }, due_date: { type: 'string' }, gst_applied: { type: 'boolean' }, notes: { type: 'string' }, items: ITEMS }, ['invoice_id']) },
  { name: 'delete_invoice', description: 'Delete an invoice permanently. Needs invoice_id. The user confirms first.', input_schema: obj({ invoice_id: { type: 'integer' } }, ['invoice_id']) },
  { name: 'delete_client', description: 'Delete a client. Not possible while the client has invoices (mark them inactive with update_client instead). The user confirms first.', input_schema: obj({ client_id: { type: 'integer' } }, ['client_id']) },
  { name: 'find_organisations', description: 'Platform management only: list customer organisations with status (active / deactivated), modules and member counts.', input_schema: obj({ query: { type: 'string' } }) },
  { name: 'set_organisation_status', description: 'Platform management only: deactivate (active false) or reactivate (active true) an organisation. Needs organisation_id from find_organisations. The user confirms first.',
    input_schema: obj({ organisation_id: { type: 'integer' }, active: { type: 'boolean' } }, ['organisation_id', 'active']) },
  { name: 'set_organisation_modules', description: 'Platform management only: choose which modules an organisation can use (at least one). The user confirms first.',
    input_schema: obj({ organisation_id: { type: 'integer' }, modules: { type: 'array', items: { type: 'string', enum: ALL_MODULES } } }, ['organisation_id', 'modules']) },
  { name: 'delete_organisation', description: 'Platform management only: permanently delete an organisation and all its data. Needs organisation_id. The user confirms first.', input_schema: obj({ organisation_id: { type: 'integer' } }, ['organisation_id']) },
]; // inputs are validated in plan()/read() before anything runs
const WRITE = new Set(['update_client', 'create_client', 'record_payment', 'create_task', 'update_task', 'create_invoice', 'update_invoice', 'delete_invoice', 'delete_client',
  'set_organisation_status', 'set_organisation_modules', 'delete_organisation']);
const ST_LABEL = { todo: 'to do', in_progress: 'in progress', done: 'done' };

const SYSTEM = `You are the voice assistant inside an Indian GST invoicing app. The user speaks Hindi, English or a mix (Hinglish); speech-to-text may mis-spell names, so search loosely and pick the closest match.
Rules:
- Use the tools to look things up and to act. Never invent ids, names or amounts; get them from tool results.
- ids are internal: never say them to the user. Refer to invoices by invoice_number (e.g. INV/FY26-27/TI/0007) and to clients by name.
- For a change, first find the record, then call the change tool once. The app shows the user a confirmation card, so do not ask "are you sure" yourself.
- If several records match and you cannot tell which one, ask a short question listing them instead of guessing.
- To email or WhatsApp an invoice or reminder, use compose_message: the app opens a filled-in draft and the user sends it. Never say you cannot send email.
- If the client has no email (or mobile for WhatsApp) saved, do not send the user to another page: ask for it in one short question. When they give it, call update_client with that email/mobile and then_compose, so it is saved and the draft opens as soon as they confirm.
- Tasks: statuses are todo, in_progress, done; priorities high, medium, low. Turn relative dates ("kal", "next Friday") into YYYY-MM-DD using today's date. To assign, look the person up with find_people.
- Invoices: find the client (and products for the lines) first, then create_invoice. To edit, get_invoice first and pass the full new item list if lines change.
- Organisation tools (find_organisations, set_organisation_status, set_organisation_modules, delete_organisation) are for platform management only; they never expose an organisation's business data.
- If no tool can do what was asked, say so briefly.
- Reply in the language named in the "Reply language" line, which describes the user's latest message only. Earlier turns do not change it. Replies are spoken aloud: one or two short sentences, amounts like "₹45,000", no markdown or lists.
Latency-sensitive; begin your visible answer immediately.`;

export function registerVoice({ api, wrap, fail, hasPerm, refreshPaid, withState, saveInvoice }) {
  let client, gemini;
  const anthropic = () => (client ||= new Anthropic());
  const google = () => {
    if (!GEMINI_KEY()) throw Object.assign(new Error(NOT_SET_UP), { status: 503 });
    // 25 s cap per call so an overloaded model fails over quickly instead of hanging
    return (gemini ||= new GoogleGenAI({ apiKey: GEMINI_KEY(), httpOptions: { timeout: 25000, ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}) } }));
  };
  // Gemini accepts a plain subset of JSON Schema: drop additionalProperties / empty required lists
  const geminiSchema = ({ additionalProperties, required, properties, ...s }) => ({
    ...s, properties: Object.fromEntries(Object.entries(properties || {}).map(([k, v]) => [k, { ...v }])), ...(required?.length ? { required } : {}) });
  const GEMINI_TOOLS = [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description,
    ...(Object.keys(t.input_schema.properties).length ? { parameters: geminiSchema(t.input_schema) } : {}) })) }];
  const pending = new Map(); // id -> { uid, tid, tool, input, summary, exp }
  setInterval(() => { const now = Date.now(); for (const [k, p] of pending) if (p.exp < now) pending.delete(k); }, 6e4).unref();

  const need = (u, key) => { if (!hasPerm(u.perms, key)) throw fail(403, `You don't have permission (${key})`); };
  const clientOf = async (u, id) => (await get('SELECT * FROM clients WHERE id = ? AND tenant_id = ?', id, u.tid)) || (() => { throw fail(404, 'Client not found'); })();
  const invoiceOf = async (u, id) => (await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', id, u.tid)) || (() => { throw fail(404, 'Invoice not found'); })();

  /* ---------- read tools (run immediately) ---------- */
  const read = {
    async find_clients(u, { query }) {
      need(u, 'clients.view');
      const q = `%${String(query || '').trim()}%`;
      return (await all(`SELECT c.id, c.name, c.contact_person, c.mobile, c.email, c.gst_number, c.status,
          (SELECT COALESCE(SUM(balance_amount),0) FROM invoices i WHERE i.client_id = c.id AND i.invoice_type = 'tax') AS pending
        FROM clients c WHERE c.tenant_id = ? AND (c.name LIKE ? OR c.contact_person LIKE ? OR c.mobile LIKE ? OR c.email LIKE ? OR c.gst_number LIKE ?)
        ORDER BY c.name LIMIT 8`, u.tid, q, q, q, q, q));
    },
    async find_invoices(u, { query, client_id, status }) {
      need(u, 'invoices.view');
      const w = ['tenant_id = ?'], p = [u.tid];
      if (query) { w.push('(invoice_number LIKE ? OR client_name LIKE ?)'); p.push(`%${query}%`, `%${query}%`); }
      if (client_id) { w.push('client_id = ?'); p.push(client_id); }
      if (status === 'overdue') { w.push("invoice_type = 'tax' AND balance_amount > 0.005 AND due_date < ?"); p.push(today()); }
      else if (status && status !== 'any') { w.push('payment_status = ?'); p.push(status); }
      return (await all(`SELECT id, invoice_number, invoice_type, invoice_date, due_date, client_name, net_amount, paid_amount, balance_amount, payment_status
        FROM invoices WHERE ${w.join(' AND ')} ORDER BY invoice_date DESC, id DESC LIMIT 10`, ...p));
    },
    async get_summary(u) {
      need(u, 'dashboard.view');
      const d = new Date(), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, from = `${y}-04-01`, to = `${y + 1}-03-31`;
      const one = async (sql, ...p) => (await get(sql, u.tid, ...p));
      return {
        financial_year: `${from} to ${to}`,
        billed: r2((await one("SELECT COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND invoice_date BETWEEN ? AND ?", from, to)).s),
        collected: r2((await one("SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.tenant_id = ? AND p.paid_on BETWEEN ? AND ?", from, to)).s),
        outstanding: (await one("SELECT COUNT(*) AS invoices, COALESCE(SUM(balance_amount),0) AS amount FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005")),
        overdue: (await one("SELECT COUNT(*) AS invoices, COALESCE(SUM(balance_amount),0) AS amount FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005 AND due_date < ?", today())),
        top_pending: (await all("SELECT MAX(client_name) AS client_name, SUM(balance_amount) AS pending FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005 GROUP BY client_id ORDER BY pending DESC LIMIT 3", u.tid)),
      };
    },
  };

  Object.assign(read, {
    async find_tasks(u, { query, assignee, status, priority }) {
      need(u, 'tasks.view');
      const v = taskScope(u), w = ['t.tenant_id = ?', v.sql], p = [u.tid, ...v.params];
      if (query) { w.push('(t.title LIKE ? OR t.description LIKE ?)'); p.push(`%${query}%`, `%${query}%`); }
      if (assignee && /^(me|mine|my|mera|mujhe)$/i.test(assignee.trim())) { w.push(assignedToSql()); p.push(u.id); }
      else if (assignee) { w.push('EXISTS (SELECT 1 FROM task_assignees a JOIN users au ON au.id = a.user_id WHERE a.task_id = t.id AND au.name LIKE ?)'); p.push(`%${assignee}%`); }
      if (status === 'overdue') { w.push("t.status != 'done' AND t.due_date < ?"); p.push(today()); }
      else if (!status || status === 'open') w.push("t.status != 'done'");
      else if (status !== 'any') { w.push('t.status = ?'); p.push(status); }
      if (priority) { w.push('t.priority = ?'); p.push(priority); }
      return (await withAssignees((await all(`SELECT t.id, t.title, t.description, t.due_date, t.priority, t.status, ub.name AS assigned_by,
          (t.assigned_by = ? OR ?) AS you_can_edit_all, ${assignedToSql()} AS assigned_to_you
        FROM tasks t LEFT JOIN users ub ON ub.id = t.assigned_by
        WHERE ${w.join(' AND ')} ORDER BY t.due_date IS NULL, t.due_date LIMIT 10`, u.id, u.isAdmin ? 1 : 0, u.id, ...p))))
        .map(({ assignees, ...t }) => ({ ...t, assigned_to: assignees.map((a) => a.name) }));
    },
    async find_people(u, { query }) {
      need(u, 'tasks.view');
      return (await assignablePeople(u, 'AND u.name LIKE ?', `%${String(query || '').trim()}%`));
    },
  });
  const taskOf = async (u, id) => { const v = taskScope(u); return (await get(`SELECT t.* FROM tasks t WHERE t.id = ? AND t.tenant_id = ? AND ${v.sql}`, id, u.tid, ...v.params)) || (() => { throw fail(404, 'Task not found'); })(); };
  const personOf = async (u, id) => ((await assignable(u, id)) && (await get('SELECT id, name FROM users WHERE id = ?', id)))
    || (() => { throw fail(400, u.isAdmin ? 'That person is not in this organisation. Use find_people.' : 'Team members can only assign tasks to other team members, not admins. Use find_people.'); })();
  // same fields + rules as the Tasks page (server/tasks.js)
  const taskFields = async (u, f, current = []) => {
    const o = {};
    for (const k of ['title', 'description']) if (f[k] != null && String(f[k]).trim()) o[k] = String(f[k]).trim();
    if (f.due_date != null) { if (!/^\d{4}-\d{2}-\d{2}$/.test(f.due_date)) throw fail(400, 'Due date must be YYYY-MM-DD'); o.due_date = f.due_date; }
    if (f.priority != null) { if (!TASK_PRIORITIES.includes(f.priority)) throw fail(400, 'Priority must be high, medium or low'); o.priority = f.priority; }
    if (f.status != null) { if (!TASK_STATUSES.includes(f.status)) throw fail(400, 'Status must be todo, in_progress or done'); o.status = f.status; }
    let list = Array.isArray(f.assignees) ? f.assignees.map(Number) : null;
    if (f.add_assignees?.length || f.remove_assignees?.length) list = [...(list || current), ...(f.add_assignees || []).map(Number)].filter((id) => !(f.remove_assignees || []).map(Number).includes(id));
    if (list) o.assignees = await Promise.all([...new Set(list)].map(async (id) => (await personOf(u, id)).id));
    return o;
  };
  const describe = async (u, o) => [o.title && `"${o.title}"`, o.due_date && `due ${o.due_date.split('-').reverse().join('-')}`, o.priority && `${o.priority} priority`,
    o.status && ST_LABEL[o.status], o.assignees && (o.assignees.length ? `assigned to ${(await Promise.all(o.assignees.map(async (id) => (id === u.id ? 'you' : (await personOf(u, id)).name)))).join(', ')}` : 'unassigned')].filter(Boolean).join(', ');
  const taskWrite = async (u, t, o) => {
    if (u.isAdmin || t.assigned_by === u.id) return;
    if (!(await isAssignee(t.id, u.id))) throw fail(403, 'Only the person who assigned this task can change it');
    if (Object.keys(o).some((k) => k !== 'status')) throw fail(403, 'On a task assigned to you, you can only change its status');
  };

  /* ---------- write tools: plan (validate + describe) now, execute after confirmation ---------- */
  const plan = {
    async update_client(u, { client_id, then_compose, ...f }) {
      need(u, 'clients.edit');
      const c = (await clientOf(u, client_id));
      const next = then_compose?.kind ? (await draftFor(u, { ...then_compose, client_id: c.id })) : null;
      const changes = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
      if (!Object.keys(changes).length) throw fail(400, 'Nothing to change');
      if (changes.status && !STATUS.includes(changes.status)) throw fail(400, 'Status must be active, inactive or on_hold');
      if (changes.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(changes.email)) throw fail(400, `"${changes.email}" is not a valid email address`);
      if (changes.mobile) { changes.mobile = changes.mobile.replace(/[^\d+]/g, ''); if (!/^\+?\d{10,13}$/.test(changes.mobile)) throw fail(400, 'Mobile number should be 10 digits'); }
      const label = { status: 'status', name: 'name', contact_person: 'contact', mobile: 'mobile', email: 'email', address: 'address' };
      return { input: { client_id: c.id, ...changes, ...(next ? { then_compose: next.draft } : {}) },
        summary: `Update ${c.name}: ${Object.entries(changes).map(([k, v]) => `${label[k]} → ${k === 'status' ? v.replace('_', ' ') : v}`).join(', ')}${next ? `, then open the ${next.label}` : ''}` };
    },
    async create_client(u, f) {
      need(u, 'clients.create');
      const o = Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v).trim()]));
      if (!o.name) throw fail(400, 'Client name is required');
      if ((await get('SELECT 1 AS x FROM clients WHERE tenant_id = ? AND name = ? COLLATE NOCASE', u.tid, o.name))) throw fail(409, `A client named ${o.name} already exists`);
      return { input: o, summary: `Add client ${o.name}${o.mobile ? ` (${o.mobile})` : ''}` };
    },
    async record_payment(u, { invoice_id, amount, mode, paid_on, reference }) {
      need(u, 'payments.create');
      const inv = (await invoiceOf(u, invoice_id));
      if (inv.invoice_type !== 'tax') throw fail(400, 'Payments are recorded on tax invoices only');
      if (!(inv.balance_amount > 0.005)) throw fail(400, `${inv.invoice_number} is already fully paid`);
      const amt = r2(amount ?? inv.balance_amount);
      if (!(amt > 0) || amt > inv.balance_amount + 0.005) throw fail(400, `Amount must be between ₹1 and the balance ${inr(inv.balance_amount)}`);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(paid_on || '') ? paid_on : today();
      return { input: { invoice_id: inv.id, amount: amt, mode: mode || 'Bank Transfer', paid_on: date, reference: reference || null },
        summary: `Record ${inr(amt)} ${mode ? `via ${mode} ` : ''}on ${inv.invoice_number} (${inv.client_name})${amt >= inv.balance_amount - 0.005 ? ' — marks it paid' : ''}` };
    },
  };
  Object.assign(plan, {
    async create_task(u, f) {
      need(u, 'tasks.create');
      const o = { priority: 'medium', status: 'todo', ...(await taskFields(u, f)) };
      if (!o.title) throw fail(400, 'Task title is required');
      return { input: o, summary: `Create task ${(await describe(u, o))}` };
    },
    async update_task(u, { task_id, ...f }) {
      need(u, 'tasks.view');
      const t = (await taskOf(u, task_id));
      (await taskWrite(u, t, Object.fromEntries(Object.entries(f).filter(([, v]) => v != null)))); // permission first, so the reason is right
      const o = (await taskFields(u, f, (await all('SELECT user_id FROM task_assignees WHERE task_id = ?', t.id)).map((r) => r.user_id)));
      if (!Object.keys(o).length) throw fail(400, 'Nothing to change');
      (await taskWrite(u, t, o));
      return { input: { task_id: t.id, ...o }, summary: `Update task "${t.title}": ${(await describe(u, { ...o, title: o.title && o.title !== t.title ? o.title : undefined }))}` };
    },
  });
  const exec = {
    async create_task(u, o) {
      need(u, 'tasks.create');
      const { assignees = [], ...f } = o;
      for (const id of assignees) await personOf(u, id);
      const keys = Object.keys(f);
      const id = (await run(`INSERT INTO tasks (tenant_id, assigned_by, ${keys.join(',')}) VALUES (?, ?, ${keys.map(() => '?').join(',')})`, u.tid, u.id, ...keys.map((k) => f[k]))).lastInsertRowid;
      (await setAssignees(id, assignees));
      (await logAct(u, 'create', 'tasks', id, `${o.title} (voice)`));
      return { refresh: true, open: '#/tasks' };
    },
    async update_task(u, { task_id, ...o }) {
      need(u, 'tasks.view');
      const t = (await taskOf(u, task_id));
      (await taskWrite(u, t, o));
      const { assignees, ...f } = o, keys = Object.keys(f);
      if (keys.length) (await run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`, ...keys.map((k) => f[k]), t.id, u.tid));
      if (assignees) { for (const id of assignees) await personOf(u, id); (await setAssignees(t.id, assignees)); }
      (await logAct(u, 'update', 'tasks', t.id, `${o.title || t.title} (voice)`));
      return { refresh: true, open: '#/tasks' };
    },
    async update_client(u, { client_id, then_compose, ...ch }) {
      need(u, 'clients.edit');
      const c = (await clientOf(u, client_id));
      const o = withState({ ...ch });
      const keys = Object.keys(o);
      (await run(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`, ...keys.map((k) => o[k]), c.id, u.tid));
      (await logAct(u, 'update', 'clients', c.id, `${c.name} (voice)`));
      if (then_compose) { need(u, 'reminders.send'); return { compose: then_compose }; }
      return { refresh: true };
    },
    async create_client(u, f) {
      need(u, 'clients.create');
      const o = withState({ ...f, contact_person: f.contact_person || f.name });
      const keys = Object.keys(o);
      const id = (await run(`INSERT INTO clients (tenant_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, u.tid, ...keys.map((k) => o[k]))).lastInsertRowid;
      (await logAct(u, 'create', 'clients', id, `${o.name} (voice)`));
      return { refresh: true };
    },
    async record_payment(u, p) {
      need(u, 'payments.create');
      const inv = (await invoiceOf(u, p.invoice_id));
      if (p.amount > inv.balance_amount + 0.005) throw fail(400, 'The balance changed — this is more than what is pending now');
      (await tx(async () => {
        (await run('INSERT INTO payments (invoice_id, amount, paid_on, mode, reference, created_by) VALUES (?,?,?,?,?,?)', inv.id, p.amount, p.paid_on, p.mode, p.reference, u.id));
        (await refreshPaid(inv.id));
      }));
      (await logAct(u, 'payment', 'invoice', inv.id, `₹${p.amount} received on ${inv.invoice_number} (voice)`));
      return { refresh: true, open: `#/invoices/${inv.id}` };
    },
  };

  /* ---------- invoices, products, clients (same rules as the normal pages) ---------- */
  const primaryOrg = async (u) => (await get('SELECT * FROM organisations WHERE tenant_id = ? ORDER BY id LIMIT 1', u.tid)) || (() => { throw fail(400, 'Set up your organisation details in Settings first'); })();
  const ymd = (v, label) => { if (v == null || v === '') return undefined; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw fail(400, `${label} must be YYYY-MM-DD`); return v; };
  // AI line items -> invoice lines, filling price / GST / description from a saved product when one is named
  const lines = async (u, items) => {
    if (!Array.isArray(items) || !items.length) throw fail(400, 'Add at least one line item');
    return Promise.all(items.map(async (it) => {
      const p = it.product_id ? (await get('SELECT * FROM service_products WHERE id = ? AND tenant_id = ?', it.product_id, u.tid)) || (() => { throw fail(400, 'Product not found. Use find_products.'); })() : null;
      const l = { service_product_id: p?.id || null, sac_number: p?.sac_number || '', description: (it.description || p?.description || p?.name || '').trim(),
        price: it.price ?? p?.price, quantity: it.quantity ?? 1, tax: it.tax ?? p?.tax ?? 18, discount_percent: it.discount_percent || 0 };
      if (!l.description) throw fail(400, 'Every line needs a description or product');
      if (!(+l.price >= 0) || l.price === undefined) throw fail(400, `Price missing for "${l.description}"`);
      if (!(+l.quantity > 0)) throw fail(400, `Quantity must be more than 0 for "${l.description}"`);
      return l;
    }));
  };
  const preview = (u, org, client, items, gst) => {
    const intra = !!org.state_code && org.state_code === client.state_code;
    return calcInvoice({ items: gst ? items : items.map((i) => ({ ...i, tax: 0 })), intra }).totals;
  };
  Object.assign(read, {
    async find_products(u, { query }) {
      need(u, 'products.view');
      return (await all('SELECT id, name, price, tax, sac_number FROM service_products WHERE tenant_id = ? AND name LIKE ? ORDER BY name LIMIT 15', u.tid, `%${String(query || '').trim()}%`));
    },
    async get_invoice(u, { invoice_id }) {
      need(u, 'invoices.view');
      const inv = (await invoiceOf(u, invoice_id));
      return { id: inv.id, invoice_number: inv.invoice_number, invoice_type: inv.invoice_type, invoice_date: inv.invoice_date, due_date: inv.due_date, client_id: inv.client_id, client_name: inv.client_name,
        gst_applied: !!inv.gst_applied, notes: inv.notes, total: inv.net_amount, paid: inv.paid_amount, balance: inv.balance_amount, status: inv.payment_status,
        items: (await all('SELECT service_product_id AS product_id, description, price, quantity, tax, discount_percent FROM invoice_items WHERE invoice_id = ? ORDER BY position', inv.id)) };
    },
  });
  Object.assign(plan, {
    async create_invoice(u, f) {
      need(u, 'invoices.create');
      const c = (await clientOf(u, f.client_id)), org = (await primaryOrg(u)), type = f.invoice_type === 'proforma' ? 'proforma' : 'tax', gst = f.gst_applied !== false;
      const items = (await lines(u, f.items)), t = preview(u, org, c, items, gst);
      const input = { client_id: c.id, invoice_type: type, invoice_date: ymd(f.invoice_date, 'Invoice date') || today(), due_date: ymd(f.due_date, 'Due date') || null, gst_applied: gst, notes: f.notes || null, items };
      return { input, summary: `Create ${type === 'tax' ? 'tax invoice' : 'proforma'} for ${c.name}: ${items.length} line${items.length > 1 ? 's' : ''}, total ${inr(t.total)}${gst ? '' : ' (no GST)'}${input.due_date ? `, due ${input.due_date.split('-').reverse().join('-')}` : ''}` };
    },
    async update_invoice(u, { invoice_id, ...f }) {
      need(u, 'invoices.edit');
      const inv = (await invoiceOf(u, invoice_id)), changes = {};
      if (f.invoice_date !== undefined) changes.invoice_date = ymd(f.invoice_date, 'Invoice date');
      if (f.due_date !== undefined) changes.due_date = ymd(f.due_date, 'Due date');
      if (f.notes !== undefined) changes.notes = f.notes;
      if (f.gst_applied !== undefined) changes.gst_applied = !!f.gst_applied;
      if (f.items !== undefined) changes.items = (await lines(u, f.items));
      if (!Object.keys(changes).length) throw fail(400, 'Nothing to change');
      const what = [changes.items && `${changes.items.length} line item(s)`, changes.invoice_date && `date ${changes.invoice_date}`, changes.due_date && `due ${changes.due_date}`,
        'gst_applied' in changes && (changes.gst_applied ? 'with GST' : 'without GST'), changes.notes !== undefined && 'notes'].filter(Boolean).join(', ');
      return { input: { invoice_id: inv.id, ...changes }, summary: `Update ${inv.invoice_number} (${inv.client_name}): ${what}` };
    },
    async delete_invoice(u, { invoice_id }) {
      need(u, 'invoices.delete');
      const inv = (await invoiceOf(u, invoice_id));
      return { input: { invoice_id: inv.id }, summary: `Delete ${inv.invoice_number} (${inv.client_name}, ${inr(inv.net_amount)})${inv.paid_amount > 0 ? ' and its recorded payments' : ''}` };
    },
    async delete_client(u, { client_id }) {
      need(u, 'clients.delete');
      const c = (await clientOf(u, client_id)), n = (await get('SELECT COUNT(*) AS n FROM invoices WHERE client_id = ? AND tenant_id = ?', c.id, u.tid)).n;
      if (n) throw fail(400, `${c.name} has ${n} invoice(s), so it can't be deleted. Mark it inactive instead.`);
      return { input: { client_id: c.id }, summary: `Delete client ${c.name}` };
    },
  });
  Object.assign(exec, {
    async create_invoice(u, f) {
      need(u, 'invoices.create');
      const id = (await saveInvoice(u.tid, { ...f, organisation_id: (await primaryOrg(u)).id }, u.id));
      const i = (await get('SELECT invoice_number, client_name, total_amount FROM invoices WHERE id = ?', id));
      (await logAct(u, 'create', 'invoice', id, `${i.invoice_number} for ${i.client_name} (₹${i.total_amount}) (voice)`));
      return { refresh: true, open: `#/invoices/${id}` };
    },
    async update_invoice(u, { invoice_id, ...ch }) {
      need(u, 'invoices.edit');
      const inv = (await invoiceOf(u, invoice_id));
      const items = ch.items || (await all('SELECT service_product_id, sac_number, description, price, quantity, tax, discount_percent FROM invoice_items WHERE invoice_id = ? ORDER BY position', inv.id));
      (await saveInvoice(u.tid, { organisation_id: inv.organisation_id, client_id: inv.client_id, invoice_date: ch.invoice_date ?? inv.invoice_date, due_date: 'due_date' in ch ? ch.due_date : inv.due_date,
        notes: 'notes' in ch ? ch.notes : inv.notes, gst_applied: 'gst_applied' in ch ? ch.gst_applied : !!inv.gst_applied, tds_percent: inv.tds_percent,
        pay_qr: inv.pay_qr, pay_upi: inv.pay_upi, pay_bank: inv.pay_bank, items }, u.id, inv.id));
      (await logAct(u, 'update', 'invoice', inv.id, `${inv.invoice_number} (voice)`));
      return { refresh: true, open: `#/invoices/${inv.id}` };
    },
    async delete_invoice(u, { invoice_id }) {
      need(u, 'invoices.delete');
      const inv = (await invoiceOf(u, invoice_id));
      if (inv.converted_from_id) (await run('UPDATE invoices SET converted_to_id = NULL WHERE id = ?', inv.converted_from_id));
      (await run('DELETE FROM invoices WHERE id = ?', inv.id));
      (await logAct(u, 'delete', 'invoice', inv.id, `${inv.invoice_number} (voice)`));
      return { refresh: true, open: '#/invoices' };
    },
    async delete_client(u, { client_id }) {
      need(u, 'clients.delete');
      const c = (await clientOf(u, client_id));
      (await run('DELETE FROM clients WHERE id = ? AND tenant_id = ?', c.id, u.tid));
      (await logAct(u, 'delete', 'clients', c.id, `${c.name} (voice)`));
      return { refresh: true };
    },
  });

  /* ---------- platform management: organisations (no business data, same as the Organisations page) ---------- */
  const mgmtOnly = (u) => { if (!u.isManagement) throw fail(403, 'Only platform management can manage organisations'); };
  const orgOf = async (id) => (await get('SELECT * FROM tenants WHERE id = ? AND is_platform = 0', id)) || (() => { throw fail(404, 'Organisation not found. Use find_organisations.'); })();
  read.find_organisations = async (u, { query }) => {
    mgmtOnly(u);
    return (await all(`SELECT t.id, t.name, t.active, t.modules, (SELECT COUNT(*) FROM memberships WHERE tenant_id = t.id AND status = 'approved') AS members
      FROM tenants t WHERE t.is_platform = 0 AND t.name LIKE ? ORDER BY t.name LIMIT 20`, `%${String(query || '').trim()}%`))
      .map((t) => ({ ...t, active: !!t.active, modules: tenantModules(t.modules) }));
  };
  Object.assign(plan, {
    async set_organisation_status(u, { organisation_id, active }) {
      mgmtOnly(u);
      const t = (await orgOf(organisation_id));
      if (!!t.active === !!active) throw fail(400, `${t.name} is already ${active ? 'active' : 'deactivated'}`);
      return { input: { organisation_id: t.id, active: !!active }, summary: `${active ? 'Reactivate' : 'Deactivate'} ${t.name}${active ? '' : ' (its members lose access until reactivated; no data is deleted)'}` };
    },
    async set_organisation_modules(u, { organisation_id, modules }) {
      mgmtOnly(u);
      const t = (await orgOf(organisation_id));
      if (!Array.isArray(modules) || !modules.length || modules.some((m) => !MODULES[m])) throw fail(400, `Pick at least one of: ${ALL_MODULES.join(', ')}`);
      const m = ALL_MODULES.filter((x) => modules.includes(x));
      return { input: { organisation_id: t.id, modules: m }, summary: `Set ${t.name} modules to ${m.map((x) => MODULES[x].label).join(' and ')}` };
    },
    async delete_organisation(u, { organisation_id }) {
      mgmtOnly(u);
      const t = (await orgOf(organisation_id));
      return { input: { organisation_id: t.id }, summary: `Permanently delete ${t.name} and all its data. This cannot be undone` };
    },
  });
  Object.assign(exec, {
    async set_organisation_status(u, { organisation_id, active }) {
      mgmtOnly(u);
      const t = (await orgOf(organisation_id));
      (await run('UPDATE tenants SET active = ? WHERE id = ?', active ? 1 : 0, t.id));
      (await logAct(u, active ? 'activate' : 'deactivate', 'organisations', t.id, `${t.name} ${active ? 'reactivated' : 'deactivated'} by management (voice)`, t.id));
      return { refresh: true, open: '#/organisations' };
    },
    async set_organisation_modules(u, { organisation_id, modules }) {
      mgmtOnly(u);
      const t = (await orgOf(organisation_id));
      (await run('UPDATE tenants SET modules = ? WHERE id = ?', JSON.stringify(modules), t.id));
      (await logAct(u, 'update', 'organisations', t.id, `${t.name}: modules ${modules.join(', ')} (voice)`, t.id));
      return { refresh: true, open: '#/organisations' };
    },
    async delete_organisation(u, { organisation_id }) {
      mgmtOnly(u);
      const t = (await orgOf(organisation_id));
      (await deleteTenant(t.id));
      console.log(`Organisation ${t.id} (${t.name}) deleted by management user ${u.email} (voice)`);
      return { refresh: true, open: '#/organisations' };
    },
  });

  // Draft an email / WhatsApp message: validated here, opened in the browser through the app's normal "Send" window.
  async function draftFor(u, { kind, channel, invoice_id, client_id }) {
    need(u, 'reminders.send');
    if (!['invoice', 'reminder'].includes(kind) || !['email', 'whatsapp'].includes(channel)) throw fail(400, 'Say whether to send an invoice or a reminder, by email or WhatsApp');
    const inv = invoice_id ? (await invoiceOf(u, invoice_id)) : null;
    if (kind === 'invoice' && !inv) throw fail(400, 'Which invoice? Find it first with find_invoices.');
    const c = (await clientOf(u, client_id || inv?.client_id));
    if (inv && inv.client_id !== c.id) throw fail(400, 'That invoice belongs to a different client');
    const what = kind === 'invoice' ? `invoice ${inv.invoice_number}` : inv ? `reminder for ${inv.invoice_number}` : 'payment reminder';
    return { c, inv, draft: { kind, channel, client_id: c.id, invoice_id: inv?.id || null }, label: `${channel === 'email' ? 'email' : 'WhatsApp'} draft of the ${what}` };
  }
  async function compose(u, input, out) {
    const { c, inv, draft, label } = (await draftFor(u, input));
    const to = input.channel === 'email' ? c.email || inv?.client_email : c.mobile;
    if (!to) return `${c.name} has no ${input.channel === 'email' ? 'email address' : 'mobile number'} saved, so no draft was opened. Ask the user for it, then use update_client with then_compose.`;
    out.compose = draft;
    return `Opened the ${label} to ${c.name} (${to})${inv ? `, invoice_number ${inv.invoice_number}, amount ${inr(inv.net_amount)}` : ''}. The user reviews it and presses send.`;
  }

  /* ---------- endpoints ---------- */
  api.post('/voice/command', async (req, res) => {
    const u = req.user, text = String(req.body?.text || '').trim().slice(0, 600);
    if (!text) return res.status(400).json({ error: 'Say or type a command' });
    // short plain-text history so follow-ups like "haan, uska bhi" work
    const history = (Array.isArray(req.body.history) ? req.body.history : []).slice(-6)
      .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.text === 'string' && m.text.trim())
      .map((m) => ({ role: m.role, content: m.text.slice(0, 600) }));
    while (history.length && history[0].role !== 'user') history.shift();
    const out = { reply: '', pending: null, navigate: null, compose: null };
    try {
      const system = `${SYSTEM}\nToday: ${today()}. You are talking to ${u.name}.\nReply language: ${replyLang(text)}.`;
      await (PROVIDER === 'gemini' ? runGemini : runClaude)(u, history, text, out, system);
      if (!out.reply) out.reply = out.pending ? out.pending.summary : out.compose ? 'Opening the draft.' : out.navigate ? 'Opening it.' : 'Done.';
      res.json(out);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: NOT_SET_UP });
      if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'The assistant is busy. Try again in a moment.' });
      if (e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIError) { console.error('voice api', e.status, e.message); return res.status(502).json({ error: 'The assistant could not be reached. Try again.' }); }
      if (e instanceof GeminiError) {
        console.error('voice gemini', e.status, e.message);
        if (e.status === 400 && /api key/i.test(e.message)) return res.status(503).json({ error: 'The Gemini API key is not valid. Check GEMINI_API_KEY.' });
        if (e.status === 401 || e.status === 403) return res.status(503).json({ error: 'The Gemini API key is not valid. Check GEMINI_API_KEY.' });
        if (e.status === 429) return res.status(429).json({ error: 'Free Gemini limit reached for now. Wait a minute and try again.' });
        let detail = ''; try { detail = JSON.parse(e.message).error?.message || ''; } catch { detail = String(e.message || ''); }
        if (e.status === 404) return res.status(502).json({ error: 'No Gemini model is available for this key right now. Set VOICE_MODEL in .env (e.g. gemini-3.5-flash).' });
        if ([500, 503, 504].includes(e.status)) return res.status(502).json({ error: 'Gemini is overloaded right now. Try again in a moment.' });
        return res.status(502).json({ error: `Gemini error (${e.status}): ${detail.slice(0, 200)}` });
      }
      if (/api key|apiKey|authentication/i.test(e?.message || '') && !e.status) return res.status(503).json({ error: NOT_SET_UP });
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // One tool call -> text result for the model. Changes are only planned here (pending), never executed.
  async function runTool(u, name, input, out) {
    try {
      if (name === 'open_page') { out.navigate = PAGES[input?.page] || null; return { content: 'Opened.' }; }
      if (name === 'compose_message') return { content: (await compose(u, input || {}, out)) };
      if (WRITE.has(name)) {
        if (out.pending) throw fail(400, 'Only one change at a time. Ask the user to confirm the first one.');
        const p = (await plan[name](u, input || {}));
        const id = crypto.randomBytes(12).toString('hex');
        pending.set(id, { uid: u.id, tid: u.tid, tool: name, input: p.input, summary: p.summary, exp: Date.now() + 5 * 6e4 });
        out.pending = { id, summary: p.summary };
        return { content: `Prepared: ${p.summary}. The user is now shown a confirm button; tell them briefly what will happen.` };
      }
      if (read[name]) return { content: JSON.stringify((await read[name](u, input || {}))) };
      throw fail(400, 'Unknown tool');
    } catch (e) {
      if (!e.status) console.error('voice tool', name, e);
      return { content: e.status ? e.message : 'That failed.', isError: true };
    }
  }

  async function runClaude(u, history, text, out, system) {
    const messages = [...history, { role: 'user', content: text }];
    for (let step = 0; step < 6; step++) {
      const r = await anthropic().beta.messages.create({
        model: MODEL, max_tokens: 2048, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'low' }, system, tools: TOOLS, messages,
      });
      if (r.stop_reason === 'refusal') { out.reply = "Sorry, I can't help with that."; return; }
      const said = r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      const calls = r.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) { out.reply = said; return; }
      messages.push({ role: 'assistant', content: r.content });
      const results = [];
      for (const c of calls) { const t = await runTool(u, c.name, c.input, out); results.push({ type: 'tool_result', tool_use_id: c.id, content: t.content, is_error: !!t.isError }); }
      messages.push({ role: 'user', content: results });
    }
  }

  let geminiModel = 0; // index of the last model that answered (sticky)
  async function geminiCall(contents, system) {
    let lastErr;
    for (let k = 0; k < GEMINI_MODELS.length; k++) {
      const i = (geminiModel + k) % GEMINI_MODELS.length;
      try {
        const r = await google().models.generateContent({ model: GEMINI_MODELS[i], contents, config: { systemInstruction: system, tools: GEMINI_TOOLS, temperature: 0.2 } });
        geminiModel = i;
        return r;
      } catch (e) {
        const timedOut = /abort|timed? ?out/i.test(e?.name + ' ' + e?.message);
        if (!timedOut && (!(e instanceof GeminiError) || ![404, 429, 500, 503, 504].includes(e.status))) throw e;
        console.warn(`voice: ${GEMINI_MODELS[i]} ${timedOut ? 'timed out' : 'returned ' + e.status}, trying next model`);
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async function runGemini(u, history, text, out, system) {
    const contents = [...history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), { role: 'user', parts: [{ text }] }];
    for (let step = 0; step < 6; step++) {
      const r = await geminiCall(contents, system);
      const calls = r.functionCalls || [];
      if (!calls.length) { out.reply = (r.text || '').trim(); return; }
      contents.push(r.candidates[0].content);
      const parts = [];
      for (const c of calls) {
        const t = await runTool(u, c.name, c.args, out);
        parts.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: t.isError ? { error: t.content } : { result: t.content } } });
      }
      contents.push({ role: 'user', parts });
    }
  }

  api.post('/voice/confirm', wrap(async (req) => {
    const p = pending.get(String(req.body?.id || ''));
    if (!p || p.uid !== req.user.id || p.tid !== req.user.tid || p.exp < Date.now()) throw fail(410, 'This request expired. Please say it again.');
    pending.delete(req.body.id);
    if (req.body.cancel) return { ok: true, reply: 'Cancelled.' };
    const r = (await tx(async () => (await exec[p.tool](req.user, p.input))));
    return { ok: true, reply: `Done — ${p.summary.charAt(0).toLowerCase() + p.summary.slice(1)}.`, ...r };
  }));

  return { _test: { read, plan, exec, pending } };
}
