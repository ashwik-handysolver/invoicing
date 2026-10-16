// Voice / text assistant: Claude turns a spoken command (Hindi, English or Hinglish) into one of a fixed set of
// app actions. Reads run immediately; every change is held as a pending action until the user confirms it.
// All actions run as the signed-in user: same permissions, same organisation scope as the normal API.
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, ApiError as GeminiError } from '@google/genai';
import { all, get, run, tx } from './db.js';
import { r2 } from './calc.js';
import { logAct } from './activity.js';

// Provider: VOICE_PROVIDER=claude|gemini, or picked from whichever key is set (Claude first).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const PROVIDER = process.env.VOICE_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'claude' : GEMINI_KEY() ? 'gemini' : 'claude');
const MODEL = process.env.VOICE_MODEL || (PROVIDER === 'gemini' ? 'gemini-3.5-flash' : 'claude-opus-5-5');
// Gemini: if a model is busy (503), retired (404) or out of free quota (429), try the next one.
const GEMINI_MODELS = [...new Set([MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
const NOT_SET_UP = 'Voice is not set up: add GEMINI_API_KEY (free at aistudio.google.com) or ANTHROPIC_API_KEY on the server.';
const STATUS = ['active', 'inactive', 'on_hold'];
const PAGES = { dashboard: '#/dashboard', invoices: '#/invoices', payments: '#/payments', reminders: '#/reminders', clients: '#/clients',
  products: '#/products', expenses: '#/expenses', gst: '#/gst', recurring: '#/recurring', settings: '#/settings', new_invoice: '#/invoices/new?type=tax' };
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
]; // inputs are validated in plan()/read() before anything runs
const WRITE = new Set(['update_client', 'create_client', 'record_payment']);

const SYSTEM = `You are the voice assistant inside an Indian GST invoicing app. The user speaks Hindi, English or a mix (Hinglish); speech-to-text may mis-spell names, so search loosely and pick the closest match.
Rules:
- Use the tools to look things up and to act. Never invent ids, names or amounts; get them from tool results.
- ids are internal: never say them to the user. Refer to invoices by invoice_number (e.g. INV/FY26-27/TI/0007) and to clients by name.
- For a change, first find the record, then call the change tool once. The app shows the user a confirmation card, so do not ask "are you sure" yourself.
- If several records match and you cannot tell which one, ask a short question listing them instead of guessing.
- To email or WhatsApp an invoice or reminder, use compose_message: the app opens a filled-in draft and the user sends it. Never say you cannot send email.
- If the client has no email (or mobile for WhatsApp) saved, do not send the user to another page: ask for it in one short question. When they give it, call update_client with that email/mobile and then_compose, so it is saved and the draft opens as soon as they confirm.
- If no tool can do what was asked, say so briefly.
- Reply in the language named in the "Reply language" line, which describes the user's latest message only. Earlier turns do not change it. Replies are spoken aloud: one or two short sentences, amounts like "₹45,000", no markdown or lists.
Latency-sensitive; begin your visible answer immediately.`;

export function registerVoice({ api, wrap, fail, hasPerm, refreshPaid, withState }) {
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
  const clientOf = (u, id) => get('SELECT * FROM clients WHERE id = ? AND tenant_id = ?', id, u.tid) || (() => { throw fail(404, 'Client not found'); })();
  const invoiceOf = (u, id) => get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', id, u.tid) || (() => { throw fail(404, 'Invoice not found'); })();

  /* ---------- read tools (run immediately) ---------- */
  const read = {
    find_clients(u, { query }) {
      need(u, 'clients.view');
      const q = `%${String(query || '').trim()}%`;
      return all(`SELECT c.id, c.name, c.contact_person, c.mobile, c.email, c.gst_number, c.status,
          (SELECT COALESCE(SUM(balance_amount),0) FROM invoices i WHERE i.client_id = c.id AND i.invoice_type = 'tax') AS pending
        FROM clients c WHERE c.tenant_id = ? AND (c.name LIKE ? OR c.contact_person LIKE ? OR c.mobile LIKE ? OR c.email LIKE ? OR c.gst_number LIKE ?)
        ORDER BY c.name LIMIT 8`, u.tid, q, q, q, q, q);
    },
    find_invoices(u, { query, client_id, status }) {
      need(u, 'invoices.view');
      const w = ['tenant_id = ?'], p = [u.tid];
      if (query) { w.push('(invoice_number LIKE ? OR client_name LIKE ?)'); p.push(`%${query}%`, `%${query}%`); }
      if (client_id) { w.push('client_id = ?'); p.push(client_id); }
      if (status === 'overdue') { w.push("invoice_type = 'tax' AND balance_amount > 0.005 AND due_date < ?"); p.push(today()); }
      else if (status && status !== 'any') { w.push('payment_status = ?'); p.push(status); }
      return all(`SELECT id, invoice_number, invoice_type, invoice_date, due_date, client_name, net_amount, paid_amount, balance_amount, payment_status
        FROM invoices WHERE ${w.join(' AND ')} ORDER BY invoice_date DESC, id DESC LIMIT 10`, ...p);
    },
    get_summary(u) {
      need(u, 'dashboard.view');
      const d = new Date(), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, from = `${y}-04-01`, to = `${y + 1}-03-31`;
      const one = (sql, ...p) => get(sql, u.tid, ...p);
      return {
        financial_year: `${from} to ${to}`,
        billed: r2(one("SELECT COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND invoice_date BETWEEN ? AND ?", from, to).s),
        collected: r2(one("SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.tenant_id = ? AND p.paid_on BETWEEN ? AND ?", from, to).s),
        outstanding: one("SELECT COUNT(*) AS invoices, COALESCE(SUM(balance_amount),0) AS amount FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005"),
        overdue: one("SELECT COUNT(*) AS invoices, COALESCE(SUM(balance_amount),0) AS amount FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005 AND due_date < ?", today()),
        top_pending: all("SELECT client_name, SUM(balance_amount) AS pending FROM invoices WHERE tenant_id = ? AND invoice_type='tax' AND balance_amount > 0.005 GROUP BY client_id ORDER BY pending DESC LIMIT 3", u.tid),
      };
    },
  };

  /* ---------- write tools: plan (validate + describe) now, execute after confirmation ---------- */
  const plan = {
    update_client(u, { client_id, then_compose, ...f }) {
      need(u, 'clients.edit');
      const c = clientOf(u, client_id);
      const next = then_compose?.kind ? draftFor(u, { ...then_compose, client_id: c.id }) : null;
      const changes = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
      if (!Object.keys(changes).length) throw fail(400, 'Nothing to change');
      if (changes.status && !STATUS.includes(changes.status)) throw fail(400, 'Status must be active, inactive or on_hold');
      if (changes.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(changes.email)) throw fail(400, `"${changes.email}" is not a valid email address`);
      if (changes.mobile) { changes.mobile = changes.mobile.replace(/[^\d+]/g, ''); if (!/^\+?\d{10,13}$/.test(changes.mobile)) throw fail(400, 'Mobile number should be 10 digits'); }
      const label = { status: 'status', name: 'name', contact_person: 'contact', mobile: 'mobile', email: 'email', address: 'address' };
      return { input: { client_id: c.id, ...changes, ...(next ? { then_compose: next.draft } : {}) },
        summary: `Update ${c.name}: ${Object.entries(changes).map(([k, v]) => `${label[k]} → ${k === 'status' ? v.replace('_', ' ') : v}`).join(', ')}${next ? `, then open the ${next.label}` : ''}` };
    },
    create_client(u, f) {
      need(u, 'clients.create');
      const o = Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v).trim()]));
      if (!o.name) throw fail(400, 'Client name is required');
      if (get('SELECT 1 AS x FROM clients WHERE tenant_id = ? AND name = ? COLLATE NOCASE', u.tid, o.name)) throw fail(409, `A client named ${o.name} already exists`);
      return { input: o, summary: `Add client ${o.name}${o.mobile ? ` (${o.mobile})` : ''}` };
    },
    record_payment(u, { invoice_id, amount, mode, paid_on, reference }) {
      need(u, 'payments.create');
      const inv = invoiceOf(u, invoice_id);
      if (inv.invoice_type !== 'tax') throw fail(400, 'Payments are recorded on tax invoices only');
      if (!(inv.balance_amount > 0.005)) throw fail(400, `${inv.invoice_number} is already fully paid`);
      const amt = r2(amount ?? inv.balance_amount);
      if (!(amt > 0) || amt > inv.balance_amount + 0.005) throw fail(400, `Amount must be between ₹1 and the balance ${inr(inv.balance_amount)}`);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(paid_on || '') ? paid_on : today();
      return { input: { invoice_id: inv.id, amount: amt, mode: mode || 'Bank Transfer', paid_on: date, reference: reference || null },
        summary: `Record ${inr(amt)} ${mode ? `via ${mode} ` : ''}on ${inv.invoice_number} (${inv.client_name})${amt >= inv.balance_amount - 0.005 ? ' — marks it paid' : ''}` };
    },
  };
  const exec = {
    update_client(u, { client_id, then_compose, ...ch }) {
      need(u, 'clients.edit');
      const c = clientOf(u, client_id);
      const o = withState({ ...ch });
      const keys = Object.keys(o);
      run(`UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`, ...keys.map((k) => o[k]), c.id, u.tid);
      logAct(u, 'update', 'clients', c.id, `${c.name} (voice)`);
      if (then_compose) { need(u, 'reminders.send'); return { compose: then_compose }; }
      return { refresh: true };
    },
    create_client(u, f) {
      need(u, 'clients.create');
      const o = withState({ ...f, contact_person: f.contact_person || f.name });
      const keys = Object.keys(o);
      const id = run(`INSERT INTO clients (tenant_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, u.tid, ...keys.map((k) => o[k])).lastInsertRowid;
      logAct(u, 'create', 'clients', id, `${o.name} (voice)`);
      return { refresh: true };
    },
    record_payment(u, p) {
      need(u, 'payments.create');
      const inv = invoiceOf(u, p.invoice_id);
      if (p.amount > inv.balance_amount + 0.005) throw fail(400, 'The balance changed — this is more than what is pending now');
      tx(() => {
        run('INSERT INTO payments (invoice_id, amount, paid_on, mode, reference, created_by) VALUES (?,?,?,?,?,?)', inv.id, p.amount, p.paid_on, p.mode, p.reference, u.id);
        refreshPaid(inv.id);
      });
      logAct(u, 'payment', 'invoice', inv.id, `₹${p.amount} received on ${inv.invoice_number} (voice)`);
      return { refresh: true, open: `#/invoices/${inv.id}` };
    },
  };

  // Draft an email / WhatsApp message: validated here, opened in the browser through the app's normal "Send" window.
  function draftFor(u, { kind, channel, invoice_id, client_id }) {
    need(u, 'reminders.send');
    if (!['invoice', 'reminder'].includes(kind) || !['email', 'whatsapp'].includes(channel)) throw fail(400, 'Say whether to send an invoice or a reminder, by email or WhatsApp');
    const inv = invoice_id ? invoiceOf(u, invoice_id) : null;
    if (kind === 'invoice' && !inv) throw fail(400, 'Which invoice? Find it first with find_invoices.');
    const c = clientOf(u, client_id || inv?.client_id);
    if (inv && inv.client_id !== c.id) throw fail(400, 'That invoice belongs to a different client');
    const what = kind === 'invoice' ? `invoice ${inv.invoice_number}` : inv ? `reminder for ${inv.invoice_number}` : 'payment reminder';
    return { c, inv, draft: { kind, channel, client_id: c.id, invoice_id: inv?.id || null }, label: `${channel === 'email' ? 'email' : 'WhatsApp'} draft of the ${what}` };
  }
  function compose(u, input, out) {
    const { c, inv, draft, label } = draftFor(u, input);
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
      const system = `${SYSTEM}\nReply language: ${replyLang(text)}.`;
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
  function runTool(u, name, input, out) {
    try {
      if (name === 'open_page') { out.navigate = PAGES[input?.page] || null; return { content: 'Opened.' }; }
      if (name === 'compose_message') return { content: compose(u, input || {}, out) };
      if (WRITE.has(name)) {
        if (out.pending) throw fail(400, 'Only one change at a time. Ask the user to confirm the first one.');
        const p = plan[name](u, input || {});
        const id = crypto.randomBytes(12).toString('hex');
        pending.set(id, { uid: u.id, tid: u.tid, tool: name, input: p.input, summary: p.summary, exp: Date.now() + 5 * 6e4 });
        out.pending = { id, summary: p.summary };
        return { content: `Prepared: ${p.summary}. The user is now shown a confirm button; tell them briefly what will happen.` };
      }
      if (read[name]) return { content: JSON.stringify(read[name](u, input || {})) };
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
      messages.push({ role: 'user', content: calls.map((c) => { const t = runTool(u, c.name, c.input, out); return { type: 'tool_result', tool_use_id: c.id, content: t.content, is_error: !!t.isError }; }) });
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
      contents.push({ role: 'user', parts: calls.map((c) => {
        const t = runTool(u, c.name, c.args, out);
        return { functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: t.isError ? { error: t.content } : { result: t.content } } };
      }) });
    }
  }

  api.post('/voice/confirm', wrap((req) => {
    const p = pending.get(String(req.body?.id || ''));
    if (!p || p.uid !== req.user.id || p.tid !== req.user.tid || p.exp < Date.now()) throw fail(410, 'This request expired. Please say it again.');
    pending.delete(req.body.id);
    if (req.body.cancel) return { ok: true, reply: 'Cancelled.' };
    const r = tx(() => exec[p.tool](req.user, p.input));
    return { ok: true, reply: `Done — ${p.summary.charAt(0).toLowerCase() + p.summary.slice(1)}.`, ...r };
  }));

  return { _test: { read, plan, exec, pending } };
}
