// Organisation signup, join-by-code and membership approval.
// A "tenant" is the organisation people sign up for; everything else in the app is scoped to req.user.tid.
import { all, get, run, tx, normCode, newInviteCode } from './db.js';
import { createTenant, DEFAULT_MEMBER_ROLE } from './seed.js';
import { logAct } from './activity.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_RE = /^[\w.-]{2,256}@[A-Za-z][\w]{1,63}$/;

// Small fixed-window limiter for the unauthenticated endpoints (per IP and bucket).
const hits = new Map();
const limit = (bucket, max, minutes = 15) => (req, res, next) => {
  const k = `${bucket}:${req.ip}`, now = Date.now(), h = hits.get(k);
  if (!h || now > h.reset) hits.set(k, { n: 1, reset: now + minutes * 6e4 });
  else if (++h.n > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 6e5).unref();

// Bank details are stored as the labelled text block printed on invoices.
const BANK_FIELDS = [['bank_name', 'Bank Name'], ['account_name', 'Account Name'], ['account_number', 'A/c Number'], ['ifsc', 'IFSC Code'], ['branch', 'Branch']];
const parseBank = (text) => Object.fromEntries(BANK_FIELDS.map(([k, label]) => {
  const m = String(text || '').match(new RegExp(`^${label.replace(/[/]/g, '\\/')}\\s*:\\s*(.*)$`, 'mi'));
  return [k, m ? m[1].trim() : ''];
}));
const mask = (n) => (n ? '•'.repeat(Math.max(0, n.length - 4)) + n.slice(-4) : '');

export function registerOrgs({ app, base, wrap, fail, hashPassword, checkPassword, newSession, hasPerm }) {
  const cleanEmail = (e) => String(e || '').trim().toLowerCase();
  const checkEmail = (e) => { if (!EMAIL_RE.test(e) || e.length > 254) throw fail(400, 'Enter a valid email address'); };
  const checkNewPassword = (pw) => {
    if (typeof pw !== 'string' || pw.length < 8) throw fail(400, 'Password must be at least 8 characters');
    if (pw.length > 200) throw fail(400, 'Password is too long');
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw fail(400, 'Password must include at least one letter and one number');
  };
  const nameFromEmail = (e) => e.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim().slice(0, 80) || 'User';
  const tenantByCode = (code) => {
    const c = normCode(code);
    if (!c) throw fail(400, 'Organisation codes look like ABCDE-23456');
    const t = get('SELECT id, name FROM tenants WHERE invite_code = ?', c);
    if (!t) throw fail(404, "That code doesn't match any organisation. Check it with your admin and try again.");
    return t;
  };
  const current = (uid) => get(`SELECT m.*, t.name AS tenant_name FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND m.status IN ('pending','approved')`, uid);

  // Creates (or reuses) the user's pending request. Never grants access by itself.
  function requestMembership(user, t) {
    const cur = current(user.id);
    if (cur?.tenant_id === t.id) return cur.status; // already waiting / already in: no duplicate request
    if (cur?.status === 'approved') throw fail(409, `You already belong to ${cur.tenant_name}.`);
    if (cur) throw fail(409, `You already have a pending request to join ${cur.tenant_name}. Cancel it before joining another organisation.`);
    if (get("SELECT 1 AS x FROM memberships WHERE user_id = ? AND tenant_id = ? AND status = 'rejected'", user.id, t.id)) {
      throw fail(403, `${t.name} declined your earlier request. Contact its admin if this is a mistake.`);
    }
    const id = run("INSERT INTO memberships (tenant_id, user_id, role, status) VALUES (?, ?, 'member', 'pending')", t.id, user.id).lastInsertRowid;
    logAct(null, 'request', 'membership', id, `${user.email} asked to join`, t.id);
    return 'pending';
  }

  /* ---------------- public */
  app.post('/api/signup', limit('signup', 10), wrap((req) => {
    const b = req.body || {}, email = cleanEmail(b.email), name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw fail(400, 'Enter your name');
    checkEmail(email);
    checkNewPassword(b.password);
    if (b.confirm !== undefined && b.confirm !== b.password) throw fail(400, 'Passwords do not match');
    if (get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw fail(409, 'An account with this email already exists. Sign in instead.');
    const uid = tx(() => {
      const id = run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', name, email, hashPassword(b.password)).lastInsertRowid;
      const { tid } = createTenant(id, `${name.split(' ')[0]}'s organisation`);
      logAct({ id, name, tid }, 'create', 'organisation', tid, `organisation created by ${email}`);
      return id;
    });
    return { token: newSession(uid) };
  }));

  app.post('/api/join/lookup', limit('lookup', 30), wrap((req) => ({ organisation: tenantByCode(req.body?.code).name })));

  app.post('/api/join', limit('join', 15), wrap((req) => {
    const b = req.body || {}, email = cleanEmail(b.email);
    checkEmail(email);
    if (typeof b.password !== 'string' || !b.password) throw fail(400, 'Enter your password');
    const t = tenantByCode(b.code);
    const out = tx(() => {
      let u = get('SELECT * FROM users WHERE email = ?', email);
      if (u) {
        // existing account: prove ownership instead of creating a duplicate
        if (!u.active || !checkPassword(b.password, u.password_hash)) throw fail(401, 'This email already has an account, and the password is wrong. Use your existing password.');
      } else {
        checkNewPassword(b.password);
        const name = String(b.name || '').trim().slice(0, 80) || nameFromEmail(email);
        u = { id: run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', name, email, hashPassword(b.password)).lastInsertRowid, email };
      }
      return { uid: u.id, status: requestMembership(u, t) };
    });
    return { token: newSession(out.uid), status: out.status, organisation: t.name };
  }));

  /* ---------------- signed in, any membership state */
  base.post('/membership/request', limit('lookup', 30), wrap((req) => {
    const t = tenantByCode(req.body?.code);
    return { status: tx(() => requestMembership(req.user, t)), organisation: t.name };
  }));
  base.post('/membership/cancel', wrap((req) => {
    run("DELETE FROM memberships WHERE user_id = ? AND status = 'pending'", req.user.id);
    return { ok: true };
  }));
  // For signed-in users without an organisation (e.g. after a declined request)
  base.post('/onboarding/organisation', wrap((req) => {
    if (current(req.user.id)) throw fail(409, 'You already belong to, or are waiting to join, an organisation.');
    const { tid } = createTenant(req.user.id, `${req.user.name.split(' ')[0]}'s organisation`);
    logAct({ ...req.user, tid }, 'create', 'organisation', tid, `organisation created by ${req.user.email}`);
    return { ok: true };
  }));

  /* ---------------- admins of the current organisation */
  const admin = (req, res, next) => (req.user.tid && req.user.isAdmin ? next() : res.status(403).json({ error: 'Only organisation admins can do this' }));
  const settingsEdit = (req, res, next) => (req.user.tid && hasPerm(req.user.perms, 'settings.edit') ? next() : res.status(403).json({ error: "You don't have permission (settings.edit)" }));
  const primaryOrg = (tid) => get('SELECT * FROM organisations WHERE tenant_id = ? ORDER BY id LIMIT 1', tid);

  base.get('/organisation', admin, wrap((req) => {
    const t = get('SELECT id, name, invite_code, created_at FROM tenants WHERE id = ?', req.user.tid);
    const o = primaryOrg(req.user.tid);
    return { ...t, organisation_id: o?.id ?? null,
      setup: { details: !!(o && (o.address || o.gst_number || o.contact)), bank: !!(o && o.bank_details && o.bank_details.trim()) } };
  }));
  base.post('/organisation/invite-code', admin, wrap((req) => {
    const code = newInviteCode();
    run('UPDATE tenants SET invite_code = ? WHERE id = ?', code, req.user.tid);
    logAct(req.user, 'update', 'organisation', req.user.tid, 'invite code regenerated');
    return { invite_code: code };
  }));

  base.get('/members/requests', admin, wrap((req) => all(`SELECT m.id, m.created_at, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND m.status = 'pending' ORDER BY m.created_at, m.id`, req.user.tid)));

  const pendingRequest = (req) => {
    const m = get("SELECT m.*, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.tenant_id = ? AND m.status = 'pending'", req.params.id, req.user.tid);
    if (!m) throw fail(404, 'This request was already handled or no longer exists.');
    return m;
  };
  base.post('/members/requests/:id/approve', admin, wrap((req) => {
    tx(() => {
      const m = pendingRequest(req);
      const role = req.body?.role_id
        ? get('SELECT id, name, permissions FROM roles WHERE id = ? AND tenant_id = ?', req.body.role_id, req.user.tid)
        : get('SELECT id, name, permissions FROM roles WHERE name = ? AND tenant_id = ?', DEFAULT_MEMBER_ROLE, req.user.tid)
          || get("SELECT id, name, permissions FROM roles WHERE tenant_id = ? AND permissions NOT LIKE '%\"*\"%' ORDER BY id LIMIT 1", req.user.tid);
      if (!role) throw fail(400, 'Pick a role for this member');
      const isAdmin = JSON.parse(role.permissions).includes('*');
      run("UPDATE memberships SET status = 'approved', role = ?, decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE id = ?", isAdmin ? 'admin' : 'member', req.user.id, m.id);
      run('UPDATE users SET role_id = ? WHERE id = ?', role.id, m.user_id);
      logAct(req.user, 'approve', 'membership', m.id, `${m.email} joined as ${role.name}`);
    });
    return { ok: true };
  }));
  base.post('/members/requests/:id/reject', admin, wrap((req) => {
    const m = pendingRequest(req);
    run("UPDATE memberships SET status = 'rejected', decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE id = ?", req.user.id, m.id);
    logAct(req.user, 'reject', 'membership', m.id, `${m.email} request declined`);
    return { ok: true };
  }));

  /* ---------------- platform management: every organisation at a glance (no bank details) */
  base.get('/management/organisations', (req, res, next) => (req.user.isManagement ? next() : res.status(403).json({ error: 'Management access only' })), wrap(() => {
    const rows = all(`SELECT t.id, t.name, t.invite_code, t.created_at, cu.name AS creator_name, cu.email AS creator_email,
        (SELECT COUNT(*) FROM memberships WHERE tenant_id = t.id AND status = 'approved') AS members,
        (SELECT COUNT(*) FROM memberships WHERE tenant_id = t.id AND status = 'approved' AND role = 'admin') AS admins,
        (SELECT COUNT(*) FROM memberships WHERE tenant_id = t.id AND status = 'pending') AS pending,
        (SELECT COUNT(*) FROM memberships WHERE tenant_id = t.id AND status = 'rejected') AS rejected,
        (SELECT COUNT(*) FROM clients WHERE tenant_id = t.id) AS clients,
        (SELECT COUNT(*) FROM invoices WHERE tenant_id = t.id) AS invoices,
        (SELECT COALESCE(SUM(total_amount),0) FROM invoices WHERE tenant_id = t.id AND invoice_type = 'tax') AS billed,
        (SELECT COALESCE(SUM(balance_amount),0) FROM invoices WHERE tenant_id = t.id AND invoice_type = 'tax') AS outstanding,
        (SELECT MAX(created_at) FROM activity_log WHERE tenant_id = t.id) AS last_activity,
        o.gst_number, o.state, (o.address IS NOT NULL AND o.address != '') OR (o.gst_number IS NOT NULL AND o.gst_number != '') AS has_details,
        (o.bank_details IS NOT NULL AND TRIM(o.bank_details) != '') AS has_bank
      FROM tenants t LEFT JOIN users cu ON cu.id = t.created_by
      LEFT JOIN organisations o ON o.id = (SELECT MIN(id) FROM organisations WHERE tenant_id = t.id)
      ORDER BY t.created_at DESC, t.id DESC`).map((r) => ({ ...r, has_details: !!r.has_details, has_bank: !!r.has_bank }));
    const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
    return { rows, totals: { organisations: rows.length, members: sum('members'), pending: sum('pending'), invoices: sum('invoices'), billed: sum('billed'),
      users: get('SELECT COUNT(*) AS n FROM users WHERE is_management = 0').n } };
  }));

  /* ---------------- bank details (structured form over organisations.bank_details) */
  const orgOf = (req) => {
    const o = get('SELECT * FROM organisations WHERE id = ? AND tenant_id = ?', req.params.id, req.user.tid);
    if (!o) throw fail(404, 'Not found');
    return o;
  };
  base.get('/organisations/:id/bank', settingsEdit, wrap((req) => {
    const o = orgOf(req), b = parseBank(o.bank_details);
    // the full account number is never sent back; leave it blank to keep the saved one
    return { ...b, account_number: '', account_masked: mask(b.account_number), upi_id: o.upi_id || '' };
  }));
  base.put('/organisations/:id/bank', settingsEdit, wrap((req) => {
    const o = orgOf(req), old = parseBank(o.bank_details), body = req.body || {};
    const v = Object.fromEntries(BANK_FIELDS.map(([k]) => [k, String(body[k] ?? '').trim().slice(0, 120)]));
    v.ifsc = v.ifsc.toUpperCase();
    v.account_number = v.account_number.replace(/\s/g, '') || old.account_number;
    const upi = String(body.upi_id ?? '').trim();
    if (!v.bank_name) throw fail(400, 'Enter the bank name');
    if (!v.account_name) throw fail(400, 'Enter the account holder name');
    if (!/^\d{6,18}$/.test(v.account_number)) throw fail(400, 'Account number should be 6–18 digits');
    if (!IFSC_RE.test(v.ifsc)) throw fail(400, 'IFSC code looks like HDFC0001234 (11 characters)');
    if (upi && !UPI_RE.test(upi)) throw fail(400, 'UPI ID looks like yourname@bank');
    // keep other labelled lines (e.g. "SWIFT Code: …") that the form doesn't cover
    const known = new RegExp(`^(${BANK_FIELDS.map(([, l]) => l).join('|')})\\s*:`, 'i');
    const extra = String(o.bank_details || '').split(/\r?\n/).filter((l) => /^[\w /.-]{2,30}:\s*\S/.test(l) && !known.test(l));
    const text = [...BANK_FIELDS.filter(([k]) => v[k]).map(([k, label]) => `${label}: ${v[k]}`), ...extra].join('\n');
    run('UPDATE organisations SET bank_details = ?, upi_id = ? WHERE id = ?', text, upi || null, o.id);
    logAct(req.user, 'update', 'organisations', o.id, 'bank details updated'); // never log the numbers
    return { ok: true, account_masked: mask(v.account_number) };
  }));
}
