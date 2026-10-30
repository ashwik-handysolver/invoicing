'use strict';
/* ------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');
const compact = (n) => (n >= 1e7 ? (n / 1e7).toFixed(1) + 'Cr' : n >= 1e5 ? (n / 1e5).toFixed(1) + 'L' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n)));
const dmy = (d) => (d ? d.split(/[T ]/)[0].split('-').reverse().join('-') : '');
// local calendar date (toISOString is UTC, which is "yesterday" in India before 5:30am)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ymd(new Date());
const daysLate = (due) => (due ? Math.floor((Date.parse(todayStr()) - Date.parse(due)) / 864e5) : 0);
function progress(paid, total, slim) {
  const p = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  return `<div class="prog ${slim ? 'slim' : ''}" title="${p}% paid"><span style="width:${p}%"></span></div>`;
}
const r2 = (n) => Math.round((+n || 0) * 100) / 100;

const themeIcon = () => ic(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 18);
const mobile = () => matchMedia('(max-width: 760px)').matches;
const initials = (n) => (String(n || '?').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
const hue = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const youChip = (label = 'You') => `<span class="av xs you" title="You">${esc(initials(S.user.name))}</span><span class="tyou">${label}</span>`;
const avatar = (n, cls = '') => `<div class="av ${cls}" style="--h:${hue(n)}">${esc(initials(n))}</div>`;
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch {}
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#0e1220' : '#1f4fd8';
  $$('[data-theme-btn]').forEach((b) => (b.innerHTML = themeIcon()));
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-theme-btn]')) toggleTheme(); });
// Mic button (sidebar + mobile tab bar) opens the voice assistant
document.addEventListener('click', (e) => { if (e.target.closest('[data-mic]')) openVoice(); });

const S = { token: localStorage.getItem('token'), user: null, meta: null, badge: 0 };
// management.view belongs only to management accounts — an org admin's '*' doesn't include it
const can = (k) => !!S.user && (k === 'management.view' ? !!S.user.isManagement : S.user.perms.includes('*') || S.user.perms.includes(k));

const PUBLIC_API = ['/login', '/signup', '/join', '/join/lookup'];
async function api(path, { method = 'GET', body, raw } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error("Can't reach the server. Check your connection and try again."); }
  if (res.status === 401 && !PUBLIC_API.includes(path)) { signOut(); throw new Error('Your session expired. Please sign in again.'); }
  if (res.status === 403 && S.user?.membership?.status === 'approved') {
    const d = await res.clone().json().catch(() => ({}));
    if (d.code === 'no_membership') { boot(); throw new Error(d.error); } // access was removed while signed in
  }
  if (raw) { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed'); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
async function download(path, filename) {
  try {
    const blob = await (await api(path, { raw: true })).blob();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { toast(e.message, true); }
}
let toastTimer;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3200);
}
function modal(html, { onClose } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { ov.remove(); onClose && onClose(); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  document.body.append(ov);
  return { el: ov.firstElementChild, close };
}
// In-app confirmation dialog (replaces the browser's confirm()). Resolves true / false.
function confirmBox(msg, { ok } = {}) {
  const danger = /^(delete|reject|disable|cancel|remove)/i.test(msg);
  const label = ok || (danger ? msg.split(/\s/)[0].replace(/^./, (c) => c.toUpperCase()) : 'Confirm');
  return new Promise((resolve) => {
    let answer = false;
    const m = modal(`<div class="cfm"><span class="cfm-ic ${danger ? 'bad' : ''}">${ic(danger ? 'trash' : 'check', 22)}</span>
      <p>${esc(msg)}</p><div class="actions"><button type="button" class="btn" data-no>${danger && /^cancel/i.test(msg) ? 'Keep it' : 'Cancel'}</button>
      <button type="button" class="btn ${danger ? 'danger solid' : 'primary'}" data-yes>${esc(label)}</button></div></div>`, { onClose: () => { document.removeEventListener('keydown', key, true); resolve(answer); } });
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); m.close(); } };
    document.addEventListener('keydown', key, true);
    $('[data-no]', m.el).onclick = () => m.close();
    $('[data-yes]', m.el).onclick = () => { answer = true; m.close(); };
    setTimeout(() => $('[data-yes]', m.el)?.focus(), 30);
  });
}

/* ------------------------------------------------------------ pagination (client-side, remembered per list) */
const PG = {}, PAGE_SIZES = [10, 25, 50, 100];
const resetPg = (key) => { if (PG[key]) PG[key].page = 1; };
function paginate(key, rows) {
  const st = (PG[key] ||= { page: 1, size: 25 }), total = rows.length, pages = Math.max(1, Math.ceil(total / st.size));
  st.page = Math.min(Math.max(1, st.page), pages);
  const from = (st.page - 1) * st.size, to = Math.min(total, from + st.size);
  const nums = [...new Set([1, st.page - 1, st.page, st.page + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  let btns = '', prev = 0;
  for (const p of nums) { if (p - prev > 1) btns += '<span class="pg-gap">…</span>'; btns += `<button type="button" class="pg-b pg-num ${p === st.page ? 'on' : ''}" data-p="${p}">${p}</button>`; prev = p; }
  const html = total <= st.size ? '' : `<div class="pager noprint" data-k="${key}"><span class="pg-info">${from + 1}–${to} of ${total}</span>
    <div class="pg-ctl"><button type="button" class="pg-b" data-p="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''} aria-label="Previous page">${ic('back', 16)}</button>${btns}<button type="button" class="pg-b" data-p="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''} aria-label="Next page">${ic('chevron', 16)}</button></div>
    <select class="pg-size" aria-label="Rows per page">${PAGE_SIZES.map((s) => `<option value="${s}" ${s === st.size ? 'selected' : ''}>${s} / page</option>`).join('')}</select></div>`;
  return {
    rows: rows.slice(from, to), html,
    bind(root, redraw) {
      const bar = $(`.pager[data-k="${key}"]`, root);
      if (!bar) return;
      bar.onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b || b.disabled) return; st.page = +b.dataset.p; redraw(); window.scrollTo({ top: 0 }); };
      $('.pg-size', bar).onchange = (e) => { st.size = +e.target.value; st.page = 1; redraw(); };
    },
  };
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

/* ------------------------------------------------------------ auth + shell */
function signOut() {
  localStorage.removeItem('token'); S.token = null; S.user = null; S.meta = null;
  clearTimeout(pollTimer); sessionSet('onb', null);
  renderLogin();
}
const LOGO = '<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f4fd8"/><stop offset="1" stop-color="#6a5cff"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#lg)"/><path d="M20 13h17l9 9v29H20z" fill="#fff"/><path d="M37 13l9 9H37z" fill="#c8d6ff"/><rect x="25" y="30" width="16" height="3" rx="1.5" fill="#1f4fd8"/><rect x="25" y="37" width="16" height="3" rx="1.5" fill="#1f4fd8"/><rect x="25" y="44" width="9" height="3" rx="1.5" fill="#1f4fd8"/></svg>';

function authShell(card) {
  $('#app').innerHTML = `<div class="auth">
    <section class="auth-art" aria-hidden="true">
      <div class="art-brand">${LOGO} Invoice Manager</div>
      <h2>Bill faster.<br>Get paid sooner.</h2>
      <p>Proforma &amp; tax invoices with GST, one-tap WhatsApp / email, payment reminders and a live revenue tracker.</p>
      <div class="ticks"><span>GST invoices</span><span>UPI · QR · Bank</span><span>Payment reminders</span><span>Revenue tracker</span></div>
      <div class="mock">
        <div class="sheet"><div class="h"><div><div class="t">TAX INVOICE</div><div class="n">INV/FY26-27/TI/0042</div></div><div class="n">12-09-2026</div></div>
          <div class="bar">RAISED TO</div><div class="ln m"></div><div class="ln s"></div>
          <div class="rows"><div class="rw"><span>Service</span><span>Amount</span></div><div class="rw"><span>Website development</span><span>₹45,000</span></div><div class="rw"><span>Annual support</span><span>₹15,000</span></div></div>
          <div class="tot">Total incl. GST<b>₹70,800.00</b></div><div class="stamp">PAID</div></div>
        <div class="float f1">₹ 4,25,000<small>collected this month</small></div>
        <div class="float f2">3 reminders due<small>₹ 1,29,500 pending</small></div>
      </div>
    </section>
    <section class="m-hero" aria-hidden="true"><i class="orb o1"></i><i class="orb o2"></i>
      <div class="m-brand">${LOGO}<span>Invoice Manager</span></div>
      <h2>Bill faster.<br>Get paid sooner.</h2>
      <div class="m-stage"><div class="m-sheet"><div class="mh"><b>TAX INVOICE</b><span>#0042</span></div><i class="mb"></i><i class="ml"></i><i class="ml s"></i>
          <div class="mr"><span>Website development</span><b>₹45,000</b></div><div class="mr"><span>Annual support</span><b>₹15,000</b></div><div class="mt">₹70,800</div><div class="mstamp">PAID</div></div>
        <div class="m-chip c1"><b>₹4.25L</b><small>collected this month</small></div><div class="m-chip c2"><b>3 due today</b><small>reminders queued</small></div><div class="m-chip c3">UPI · QR · Bank</div></div>
    </section>
    <section class="auth-form">
      <button type="button" class="ibtn" data-theme-btn aria-label="Toggle theme" style="position:absolute;top:14px;right:14px">${themeIcon()}</button>
      ${card}
    </section></div>`;
  $$('[data-showpw]').forEach((b) => (b.onclick = () => { const p = b.previousElementSibling, show = p.type === 'password'; p.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; }));
  $$('[data-go]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); ({ login: renderLogin, signup: renderSignup, create: renderCreateAccount, join: renderJoin })[a.dataset.go](); }));
}
const pwField = (id, label, ac, ph) => `<div class="field"><label for="${id}">${label}</label><div class="inwrap pwwrap">${ic('lock', 18)}<input id="${id}" type="password" autocomplete="${ac}" placeholder="${ph}" required><button type="button" data-showpw aria-label="Show password">Show</button></div></div>`;
const emailField = (id = 'em') => `<div class="field"><label for="${id}">Email</label><div class="inwrap">${ic('mail', 18)}<input id="${id}" type="email" autocomplete="username" placeholder="you@company.com" maxlength="254" required></div></div>`;

function renderLogin() {
  authShell(`<form class="auth-card" id="lf" novalidate>
        <h1>Sign in</h1><p class="lead">Access your invoices, payments and reports.</p>
        <div class="stack">
          ${emailField()}
          ${pwField('pw', 'Password', 'current-password', 'Enter your password')}
          <div class="ob-err hidden" role="alert"></div>
          <button class="btn primary" id="sb">Sign in</button>
          <p class="ob-alt">New here? <a href="#" data-go="signup">Create an account</a></p>
          <p class="secure">${ic('lock', 13)} Encrypted sign-in · your data stays private</p>
        </div>
      </form>`);
  $('#lf').onsubmit = submitter($('#lf'), async () => {
    if (!$('#em').value.trim() || !$('#pw').value) throw new Error('Enter your email and password');
    const r = await api('/login', { method: 'POST', body: { email: $('#em').value, password: $('#pw').value } });
    S.token = r.token; localStorage.setItem('token', r.token);
    await boot();
  });
}

const NAV = [
  { id: 'dashboard', label: 'Revenue', icon: 'chart', perm: 'dashboard.view', hash: '#/dashboard', grp: 'Sales' },
  { id: 'invoices', label: 'Invoices', icon: 'file', perm: 'invoices.view', hash: '#/invoices', grp: 'Sales' },
  { id: 'payments', label: 'Payments', icon: 'rupee', perm: 'invoices.view', hash: '#/payments', grp: 'Sales' },
  { id: 'recurring', label: 'Recurring', icon: 'repeat', perm: 'recurring.view', hash: '#/recurring', grp: 'Sales' },
  { id: 'reminders', label: 'Reminders', icon: 'bell', perm: 'reminders.view', hash: '#/reminders', badge: true, grp: 'Sales', inHeader: true },
  { id: 'expenses', label: 'Expenses', icon: 'wallet', perm: 'expenses.view', hash: '#/expenses', grp: 'Money' },
  { id: 'gst', label: 'GST report', icon: 'percent', perm: 'gst.view', hash: '#/gst', grp: 'Reports' },
  { id: 'activity', label: 'Activity log', icon: 'clock', perm: 'activity.view', hash: '#/activity', grp: 'Reports', inSettings: true },
  { id: 'clients', label: 'Clients', icon: 'users', perm: 'clients.view', hash: '#/clients', grp: 'Setup' },
  { id: 'products', label: 'Services', icon: 'box', perm: 'products.view', hash: '#/products', grp: 'Setup' },
  { id: 'templates', label: 'Templates', icon: 'chat', perm: 'templates.view', hash: '#/templates', grp: 'Setup', inSettings: true },
  { id: 'users', label: 'Users', icon: 'user', perm: 'users.view', hash: '#/users', grp: 'Admin', inSettings: true },
  { id: 'settings', label: 'Settings', icon: 'gear', perm: 'settings.view', anyPerm: ['settings.view', 'users.view', 'templates.view', 'activity.view'], hash: '#/settings', grp: 'Admin', inSettings: true },
  { id: 'tasks', label: 'Tasks', icon: 'check', perm: 'tasks.view', hash: '#/tasks', grp: 'Tasks', sec: 'tasks' },
  { id: 'management', label: 'Dashboard', icon: 'grid', perm: 'management.view', hash: '#/management', grp: 'Management', sec: 'top' },
  { id: 'organisations', label: 'Organisations', icon: 'users', perm: 'management.view', hash: '#/organisations', grp: 'Management', sec: 'top' },
];
// The referral app linked from the "Refer & earn" button. It is told who is referring:
// ?referrerEmail=…&referrerName=… (the user's name, else the part of the email before the @).
const REFERRAL_URL = 'https://referral-umber.vercel.app/';
function referralUrl() {
  const email = S.user?.email || '';
  if (!email) return REFERRAL_URL;
  const name = (S.user.name || '').trim() || email.split('@')[0];
  return `${REFERRAL_URL}?${new URLSearchParams({ referrerEmail: email, referrerName: name })}`;
}
// On hover a sheen sweeps across, the gift hops and three sparkles twinkle one after another.
const SPARKLES = [{ x: -11, y: -11, s: 7, d: 0 }, { x: 12, y: -9, s: 5, d: 90 }, { x: 10, y: 11, s: 6, d: 170 }];
const referButton = (cls = '') => `<a class="refer-btn ${cls}" href="${esc(referralUrl())}" target="_blank" rel="noopener noreferrer" aria-label="Refer and earn (opens the referral app in a new tab)">
  <span class="refer-ic"><span class="refer-sparks" aria-hidden="true">${SPARKLES.map((p) => `<i style="--x:${p.x}px;--y:${p.y}px;--s:${p.s}px;--d:${p.d}ms"></i>`).join('')}</span><span class="refer-gift">${ic('gift', 20, 2.2)}</span></span>
  <span class="refer-lb">Refer &amp; earn</span><span class="refer-arrow">${ic('arrowUpRight', 14, 2.4)}</span></a>`;

function renderShell() {
  const items = NAV.filter((n) => !n.inSettings && !n.inHeader &&(n.anyPerm ? n.anyPerm.some(can) : n.perm ? can(n.perm) : !!S.user.membership && S.user.membership.status === 'approved'));
  const settingsOk = ['settings.view', 'users.view', 'templates.view', 'activity.view'].some(can);
  // sidebar sections, each a collapsible dropdown (open state remembered per section)
  const SECS = [{ id: 'invoicing', l: 'Invoicing', icon: 'file' }, { id: 'tasks', l: 'Task management', icon: 'clipboard' }];
  const isOpen = (id) => { try { return localStorage.getItem('nav:' + id) !== '0'; } catch { return true; } };
  const link = (n, cls) => `<a class="${cls}" data-nav="${n.id}" href="${n.hash}"><span class="ico">${ic(n.icon)}</span><span class="lb">${n.label}</span>${n.badge ? '<span class="badge hidden" data-badge></span>' : ''}</a>`;
  const bottom = ['dashboard', 'invoices', 'payments'] /* + centre mic + More (Reminders etc. are in More) */.map((id) => items.find((n) => n.id === id)).filter(Boolean);
  $('#app').innerHTML = `<div class="shell">
    <aside class="side"><div class="brand">${LOGO} Invoice Manager</div>
      ${S.user.membership?.status === 'approved' ? `<button type="button" class="side-mic" data-mic aria-label="Voice"><span>${ic('mic', 22, 2.6)}</span>Voice</button>` : ''}
      ${items.filter((n) => n.sec === 'top').map((n) => link(n, 'nav')).join('')}
      ${SECS.map((sec) => { const its = items.filter((n) => (n.sec || 'invoicing') === sec.id); if (!its.length) return ''; const o = isOpen(sec.id);
        return `<div class="navdd ${o ? 'open' : ''}" data-sec="${sec.id}"><button type="button" class="navdd-h" aria-expanded="${o}"><span class="ico">${ic(sec.icon)}</span><span class="lb">${sec.l}</span><span class="chev">${ic('chevron', 16)}</span></button>
        <div class="navdd-b"><div class="navdd-in">${its.map((n, i) => (sec.id !== 'invoicing' || (i && its[i - 1].grp === n.grp) ? '' : `<div class="navgrp">${n.grp}</div>`) + link(n, 'nav')).join('')}</div></div></div>`; }).join('')}<div class="grow"></div>
      ${referButton()}</aside>
    <div class="main"><header class="top"><div class="title" id="pt"></div>
      ${S.user.membership?.status === 'approved' ? `<button class="searchpill" id="gs" aria-label="Search">${ic('search', 17)}<span>Search invoices, clients…</span><kbd>Ctrl K</kbd></button>` : '<span class="grow"></span>'}
      ${can('invoices.create') ? `<a class="btn primary sm top-create" href="#/invoices/new?type=tax">${ic('plus')} Invoice</a>` : ''}
      ${Object.values(bellSources()).some(Boolean) ? `<div class="usermenu" id="bm"><button type="button" class="ibtn bellbtn" aria-haspopup="menu" aria-expanded="false" aria-label="Notifications" title="Notifications">${ic('bell', 18)}<span class="badge hidden" data-badge></span></button>
        <div class="um-pop notif-pop" role="menu"><div class="um-who"><b>Notifications</b></div><div class="notif-list"></div>${can('reminders.view') ? '<a class="notif-all" href="#/reminders">View all reminders</a>' : ''}</div></div>` : ''}
      <button class="ibtn" data-theme-btn aria-label="Toggle light / dark theme">${themeIcon()}</button>
      <div class="usermenu" id="um"><button type="button" class="um-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Account">${avatar(S.user.name, 'sm')}</button>
        <div class="um-pop" role="menu"><div class="um-who"><b>${esc(S.user.name)}</b><small class="muted">${esc(S.user.role)}${S.user.membership?.organisation ? ` · ${esc(S.user.membership.organisation)}` : ''}</small></div>
          <button type="button" role="menuitem" id="acct">${ic('user', 17)} My account</button>${settingsOk ? `<a role="menuitem" href="#/settings">${ic('gear', 17)} Settings</a>` : ''}<button type="button" role="menuitem" class="um-logout" id="so">${ic('logout', 17)} Log out</button></div></div></header>
      <main class="content" id="view"></main></div>
    <nav class="bottom">${bottom.slice(0, 2).map((n) => link(n, '')).join('')}${S.user.membership?.status === 'approved' ? `<button type="button" class="tab-mic" data-mic aria-label="Voice"><span>${ic('mic', 26, 2.6)}</span></button>` : ''}${bottom.slice(2).map((n) => link(n, '')).join('')}<a href="#" id="more"><span class="ico">${ic('grid')}</span><span class="lb">More</span></a></nav>
    ${can('invoices.create') ? `<a class="fab hidden" id="fab" href="#/invoices/new?type=tax" aria-label="New invoice">${ic('plus', 24)}</a>` : ''}</div>`;
  $('#acct').onclick = () => { umSet(false); openAccount(); };
  $('#so').onclick = (e) => { e.preventDefault(); api('/logout', { method: 'POST' }).catch(() => {}); signOut(); };
  $('#more').onclick = (e) => { e.preventDefault(); openMore(items); };
  if ($('#gs')) $('#gs').onclick = openSearch;
  const um = $('#um'), umb = $('.um-btn', um), umSet = (o) => { um.classList.toggle('open', o); umb.setAttribute('aria-expanded', o); };
  umb.onclick = (e) => { e.stopPropagation(); umSet(!um.classList.contains('open')); };
  $('.um-pop', um).onclick = (e) => { if (e.target.closest('a')) umSet(false); };
  document.addEventListener('click', (e) => { if (!um.contains(e.target)) umSet(false); });
  const bm = $('#bm');
  if (bm) {
    const bb = $('.bellbtn', bm), bSet = (o) => { bm.classList.toggle('open', o); bb.setAttribute('aria-expanded', o); };
    bb.onclick = (e) => { e.stopPropagation(); const o = !bm.classList.contains('open'); bSet(o); if (o) loadNotifs($('.notif-list', bm)); };
    $('.notif-pop', bm).onclick = (e) => { if (e.target.closest('a')) bSet(false); };
    document.addEventListener('click', (e) => { if (!bm.contains(e.target)) bSet(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') bSet(false); });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') umSet(false); });
  $$('.navdd').forEach((dd) => ($('.navdd-h', dd).onclick = (e) => { const o = dd.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', o); try { localStorage.setItem('nav:' + dd.dataset.sec, o ? '1' : '0'); } catch {} }));
  refreshBadge();
}
// Bell: one list for everyone: payment reminders (overdue / send today), your tasks due today or overdue,
// and for management the platform events too. Each source is included only when the user can see it.
const bellSources = () => ({ pay: can('reminders.view'), tasks: can('tasks.view'), platform: !!S.user.isManagement });
const PSEEN = 'platformSeen';
const pSeen = () => { try { return localStorage.getItem(PSEEN) || ''; } catch { return ''; } };
async function bellData() {
  const src = bellSources(), t0 = todayStr();
  const [pay, tasks, platform] = await Promise.all([
    src.pay ? api('/reminders/queue').catch(() => []) : [],
    src.tasks ? api('/tasks').then((l) => l.filter((t) => t.assignees.some((a) => a.id === S.user.id) && t.status !== 'done' && t.due_date && t.due_date <= t0)).catch(() => []) : [],
    src.platform ? api('/management/notifications').catch(() => []) : [],
  ]);
  return { pay, tasks, platform, t0 };
}
async function refreshBadge() {
  if (!$('#bm')) return;
  const d = await bellData(), seen = pSeen();
  const n = d.pay.length + d.tasks.length + d.platform.filter((x) => x.at > seen).length;
  $$('[data-badge]').forEach((b) => { b.textContent = n > 9 ? '9+' : n; b.classList.toggle('hidden', !n); });
}
async function loadNotifs(el) {
  el.innerHTML = skRows(3, 'flat sk-notif');
  const d = await bellData(), seen = pSeen(), out = [];
  const payRow = (r) => `<a class="notif" href="#/invoices/${r.id}"><div><b>${esc(r.client_name)}</b><small class="muted">${esc(r.invoice_number)} · ${money(r.balance_amount)}</small></div><span class="pill ${r.diff > 0 ? 'overdue' : 'partial'}">${esc(r.label)}</span></a>`;
  const taskRow = (t) => `<a class="notif" href="#/tasks"><div><b>${esc(t.title)}</b><small class="muted">${t.assigned_by && t.assigned_by !== S.user.id ? `From ${esc(t.assigned_by_name || '')} · ` : ''}${t.priority} priority</small></div><span class="pill ${t.due_date < d.t0 ? 'overdue' : 'partial'}">${t.due_date < d.t0 ? `${Math.round((new Date(d.t0) - new Date(t.due_date)) / 864e5)}d overdue` : 'Due today'}</span></a>`;
  const over = d.pay.filter((r) => r.diff > 0), today = d.pay.filter((r) => r.diff <= 0);
  if (over.length) out.push(`<div class="navgrp">Overdue payments</div>${over.slice(0, 5).map(payRow).join('')}`);
  if (today.length) out.push(`<div class="navgrp">Reminders to send today</div>${today.slice(0, 5).map(payRow).join('')}`);
  if (d.tasks.length) out.push(`<div class="navgrp">Tasks due</div>${d.tasks.slice(0, 5).map(taskRow).join('')}`);
  if (d.platform.length) {
    const text = { org: (x) => `<b>${esc(x.org)}</b> started using the platform${x.person ? ` <span class="muted">(${esc(x.person)})</span>` : ''}`,
      member: (x) => `<b>${esc(x.person)}</b> joined <b>${esc(x.org)}</b>`, request: (x) => `<b>${esc(x.person)}</b> requested to join <b>${esc(x.org)}</b>` };
    const icn = { org: 'grid', member: 'user', request: 'clock' };
    const when = (at) => { const dt = new Date(at.replace(' ', 'T') + 'Z'), m = Math.round((Date.now() - dt) / 6e4);
      return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); };
    out.push(`<div class="navgrp">Platform</div>${d.platform.slice(0, 8).map((x) => `<a class="pnotif ${x.at > seen ? 'new' : ''}" href="#/organisations"><span class="pn-ic ${x.kind}">${ic(icn[x.kind], 15)}</span><span class="pn-t"><span>${text[x.kind](x)}</span><small class="muted">${when(x.at)}</small></span></a>`).join('')}`);
    try { localStorage.setItem(PSEEN, d.platform[0].at); } catch {}
  }
  el.innerHTML = out.join('') || '<div class="empty small">All caught up.</div>';
  const n = d.pay.length + d.tasks.length;
  $$('[data-badge]').forEach((b) => { b.textContent = n > 9 ? '9+' : n; b.classList.toggle('hidden', !n); });
}
// Your own name, email and password (from the avatar menu). Saving needs the current password.
function openAccount() {
  const m = modal(`<h2>My account</h2><form class="grid g2" novalidate>
    <div class="field full"><label for="ac-n">Name</label><input id="ac-n" name="name" value="${esc(S.user.name)}" required autocomplete="name"></div>
    <div class="field full"><label for="ac-e">Email</label><input id="ac-e" name="email" type="email" value="${esc(S.user.email)}" required autocomplete="email"></div>
    <div class="field"><label for="ac-p">New password</label><input id="ac-p" name="new_password" type="password" placeholder="Leave blank to keep" autocomplete="new-password"></div>
    <div class="field"><label for="ac-p2">Confirm new password</label><input id="ac-p2" name="confirm" type="password" autocomplete="new-password"></div>
    <div class="field full"><label for="ac-c">Current password</label><input id="ac-c" name="current_password" type="password" required autocomplete="current-password"></div>
    <div class="ob-err hidden full" role="alert"></div>
    <div class="actions full"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save changes</button></div></form>`);
  const f = $('form', m.el), err = $('.ob-err', m.el);
  $('[data-x]', m.el).onclick = m.close;
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const show = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
    const v = Object.fromEntries(new FormData(f)), body = { current_password: v.current_password };
    if (v.name.trim() !== S.user.name) body.name = v.name.trim();
    if (v.email.trim().toLowerCase() !== S.user.email.toLowerCase()) body.email = v.email.trim();
    if (v.new_password) {
      const bad = pwProblem(v.new_password);
      if (bad) return show(bad);
      if (v.new_password !== v.confirm) return show('New passwords do not match');
      body.new_password = v.new_password;
    }
    if (Object.keys(body).length === 1) return show('Nothing to change');
    if (!body.name && !body.email && !body.new_password) return;
    if (!v.current_password) return show('Enter your current password to save');
    if (body.email && !EMAIL_RE.test(body.email)) return show('Enter a valid email address');
    try {
      const res = await api('/account', { method: 'PUT', body });
      Object.assign(S.user, res.user);
      m.close(); toast(body.new_password ? 'Account updated. Other devices were signed out.' : 'Account updated');
      renderShell(); route();
    } catch (x) { show(x.message); }
  });
  $('#ac-n', m.el).focus();
}
function openMore(items) {
  const m = modal(`<h2>Menu</h2><div class="moregrid">${items.map((n) => `<a class="moretile ${location.hash.startsWith(n.hash) ? 'on' : ''}" href="${n.hash}">${ic(n.icon)}<span>${n.label}</span>${n.badge && S.badge ? `<span class="badge">${S.badge}</span>` : ''}</a>`).join('')}</div>
    ${referButton('wide')}
    <div class="sheetfoot">${avatar(S.user.name, 'sm')}<div class="who">${esc(S.user.name)}<small>${esc(S.user.role)}</small></div>
      <button class="ibtn" data-theme-btn aria-label="Toggle theme">${themeIcon()}</button><button class="btn" id="mso">${ic('logout')} Sign out</button></div>`);
  $$('.moretile', m.el).forEach((a) => (a.onclick = () => m.close()));
  $('#mso', m.el).onclick = () => { m.close(); api('/logout', { method: 'POST' }).catch(() => {}); signOut(); };
}

async function boot() {
  if (!S.token) return renderLogin();
  try {
    S.user = (await api('/me')).user;
    const member = S.user.membership?.status === 'approved';
    if (!member && !S.user.isManagement) return renderMembership();
    S.meta = member ? await api('/meta') : { states: {}, organisations: [], permissions: {} }; // management-only login
  } catch { return S.token ? renderOffline() : renderLogin(); }
  if (S.user.membership?.status !== 'approved') { // management account without an organisation
    renderShell();
    if (!/^#\/(management|organisations)/.test(location.hash)) location.hash = '#/management';
    return route();
  }
  if (sessionGet('onb')) return resumeSetup();
  renderShell();
  if (!location.hash || location.hash === '#/') location.hash = S.user.isManagement ? '#/management' : can('dashboard.view') ? '#/dashboard' : can('invoices.view') ? '#/invoices' : can('tasks.view') ? '#/tasks' : '#/settings';
  route();
}

/* ------------------------------------------------------------ loading placeholders */
// Grey shimmering shapes laid out like the page that is loading, so the screen doesn't jump when data arrives.
const skBar = (w, h = 12, cls = '') => `<i class="sk ${cls}" style="width:${w};height:${h}px"></i>`;
const skHead = () => `<div class="sk-head"><div>${skBar('90px', 10)}${skBar('220px', 22)}</div>${skBar('120px', 38, 'r')}</div>`;
const skRows = (n, cls = '') => `<div class="card sk-list ${cls}">${Array.from({ length: n }, (_, i) => `<div class="sk-row"><i class="sk sk-av"></i><div class="sk-mid">${skBar(`${55 + ((i * 17) % 30)}%`, 12)}${skBar(`${30 + ((i * 11) % 25)}%`, 10)}</div>${skBar('70px', 14)}</div>`).join('')}</div>`;
function skeleton(kind) {
  if (kind === 'dashboard') return `<div class="sk-wrap" aria-busy="true" aria-label="Loading">${skHead()}
    <div class="sk-grid"><div class="card sk-hero">${skBar('120px', 11)}${skBar('55%', 34)}${skBar('40%', 11)}<div class="sk-chips">${skBar('110px', 26, 'r')}${skBar('90px', 26, 'r')}</div></div>
      <div class="sk-tiles">${Array.from({ length: 4 }, () => `<div class="card sk-tile"><i class="sk sk-ic"></i><div>${skBar('60px', 10)}${skBar('90px', 18)}${skBar('70px', 9)}</div></div>`).join('')}</div></div>
    <div class="sk-grid two"><div class="card">${skBar('140px', 14)}<div class="sk-chart">${Array.from({ length: 12 }, (_, i) => `<i class="sk" style="height:${30 + ((i * 37) % 60)}%"></i>`).join('')}</div></div>${skRows(5, 'flat')}</div></div>`;
  if (kind === 'detail') return `<div class="sk-wrap" aria-busy="true" aria-label="Loading">${skHead()}
    <div class="card sk-doc"><div class="sk-doc-top"><div>${skBar('160px', 18)}${skBar('110px', 11)}</div>${skBar('90px', 11)}</div>
      <div class="sk-doc-cols"><div>${skBar('80px', 9)}${skBar('70%', 12)}${skBar('55%', 11)}</div><div>${skBar('80px', 9)}${skBar('70%', 12)}${skBar('55%', 11)}</div></div>
      ${Array.from({ length: 4 }, () => `<div class="sk-line">${skBar('45%', 12)}${skBar('60px', 12)}</div>`).join('')}
      <div class="sk-total">${skBar('140px', 20)}</div></div></div>`;
  if (kind === 'cards') return `<div class="sk-wrap" aria-busy="true" aria-label="Loading">${skHead()}<div class="sk-cards">${Array.from({ length: 6 }, () => `<div class="card">${skBar('70%', 14)}${skBar('90%', 10)}${skBar('50%', 10)}<div class="sk-chips">${skBar('64px', 22, 'r')}${skBar('84px', 22, 'r')}</div></div>`).join('')}</div></div>`;
  return `<div class="sk-wrap" aria-busy="true" aria-label="Loading">${skHead()}<div class="sk-toolbar">${skBar('260px', 38, 'r')}${skBar('90px', 38, 'r')}${skBar('90px', 38, 'r')}</div>${skRows(8)}</div>`;
}
const skeletonFor = (path) => (/^#\/(dashboard|management)$/.test(path) ? 'dashboard'
  : /^#\/(invoices\/(\d+|new)|credit-notes\/\d+)/.test(path) ? 'detail' : /^#\/(tasks|organisations)$/.test(path) ? 'cards' : 'list');

/* ------------------------------------------------------------ router */
const routes = [
  [/^#\/dashboard$/, 'dashboard', 'dashboard.view', viewDashboard],
  [/^#\/invoices$/, 'invoices', 'invoices.view', viewInvoices],
  [/^#\/invoices\/new$/, 'invoices', 'invoices.create', (el, m, q) => viewInvoiceForm(el, null, q)],
  [/^#\/invoices\/(\d+)\/edit$/, 'invoices', 'invoices.edit', (el, m) => viewInvoiceForm(el, m[1])],
  [/^#\/invoices\/(\d+)$/, 'invoices', 'invoices.view', (el, m) => viewInvoice(el, m[1])],
  [/^#\/payments$/, 'payments', 'invoices.view', viewPayments],
  [/^#\/recurring$/, 'recurring', 'recurring.view', viewRecurring],
  [/^#\/expenses$/, 'expenses', 'expenses.view', (el) => crudView(el, CFG.expenses)],
  [/^#\/gst$/, 'gst', 'gst.view', viewGst],
  [/^#\/activity$/, 'settings', 'activity.view', (el) => viewSettings(el, 'activity')],
  [/^#\/credit-notes\/(\d+)$/, 'invoices', 'invoices.view', (el, m) => viewCreditNote(el, m[1])],
  [/^#\/reminders$/, 'reminders', 'reminders.view', viewReminders],
  [/^#\/clients$/, 'clients', 'clients.view', (el) => crudView(el, CFG.clients)],
  [/^#\/products$/, 'products', 'products.view', (el) => crudView(el, CFG.products)],
  [/^#\/templates$/, 'settings', 'templates.view', (el) => viewSettings(el, 'templates')],
  [/^#\/users$/, 'settings', 'users.view', (el) => viewSettings(el, 'users')],
  [/^#\/settings$/, 'settings', null, (el) => viewSettings(el)],
  [/^#\/organisations$/, 'organisations', 'management.view', viewOrgControl],
  [/^#\/tasks$/, 'tasks', 'tasks.view', viewTasks],
  [/^#\/management$/, 'management', 'management.view', viewManagement],
];
async function route() {
  if (!S.user || !$('#view')) return; // onboarding screens have no app shell
  document.body.classList.remove('menu');
  const [path, qs] = location.hash.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const view = $('#view');
  for (const [re, nav, perm, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
    if (perm && !can(perm)) { view.innerHTML = '<div class="empty card">You don\'t have access to this page.</div>'; return; }
    $('#pt').textContent = /invoices\/new/.test(path) ? 'New invoice' : /invoices\/\d+\/edit/.test(path) ? 'Edit invoice' : /invoices\/\d+/.test(path) ? 'Invoice' : /credit-notes/.test(path) ? 'Credit note' : NAV.find((n) => n.id === nav)?.label || '';
    const fab = $('#fab'); if (fab) fab.classList.toggle('hidden', !['dashboard', 'invoices', 'payments', 'reminders'].includes(nav) || /new|edit|invoices\/\d/.test(path));
    view.classList.remove('still'); // page change: let the fade-in run
    view.innerHTML = skeleton(skeletonFor(path));
    window.scrollTo(0, 0);
    try { await fn(view, m, q); } catch (e) { view.innerHTML = `<div class="empty card">${esc(e.message)}</div>`; }
    return;
  }
  view.innerHTML = '<div class="empty card">Page not found.</div>';
}
window.addEventListener('hashchange', route);
matchMedia('(max-width: 760px)').addEventListener('change', () => { if (S.user && !$('.overlay')) route(); });

/* ------------------------------------------------------------ revenue dashboard */
function fyBounds(offset = 0) {
  const d = new Date(), y = (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1) + offset;
  return [`${y}-04-01`, `${y + 1}-03-31`];
}
function monthBounds(offset = 0) {
  const d = new Date(); d.setMonth(d.getMonth() + offset, 1);
  const y = d.getFullYear(), m = d.getMonth();
  return [new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)];
}
const RANGES = {
  fy: ['This financial year', () => fyBounds(0)],
  lfy: ['Last financial year', () => fyBounds(-1)],
  month: ['This month', () => monthBounds(0)],
  lmonth: ['Last month', () => monthBounds(-1)],
  custom: ['Custom range', null],
};
let dashRange = { key: 'fy', from: null, to: null };

/* ------------------------------------------------------------ shared UI bits (v4) */
const fmtLong = (d) => (d ? new Date(d.split(/[T ]/)[0] + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
function ring(pct, size = 120, stroke = 12, color = 'var(--ok)', track = 'var(--ring-bg)', textFill = 'var(--text)') {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.min(100, Math.max(0, pct || 0)), h = size / 2;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${Math.round(p)} percent"><circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
    <circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}" transform="rotate(-90 ${h} ${h})"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-weight="700" font-size="${size * 0.22}" fill="${textFill}">${Math.round(p)}%</text></svg>`;
}
const statKey = (r) => {
  if (r.invoice_type === 'proforma') return 'proforma';
  if (r.payment_status === 'paid') return 'paid';
  if (r.balance_amount > 0.005 && daysLate(r.due_date) > 0) return 'overdue';
  return r.payment_status === 'partial' ? 'partial' : 'unpaid';
};

// Record a payment without leaving the current screen
function quickPay(inv, done) {
  const bal = r2(inv.balance_amount);
  const modes = ['UPI', 'Bank Transfer', 'Cash', 'Cheque', 'Card', 'Other'];
  const m = modal(`<h2>Record payment</h2>
    <div class="qp-head">${avatar(inv.client_name)}<div><b>${esc(inv.client_name)}</b><div class="small muted">${esc(inv.invoice_number)} · pending ${money(bal)}</div></div></div>
    <form class="stack" id="qpf"><div class="field"><label>Amount received</label><div class="amtwrap"><span>₹</span><input type="number" name="amount" step="0.01" min="0.01" max="${bal}" value="${bal}" inputmode="decimal" required></div>
        <div class="chips"><button type="button" class="chip" data-frac="1">Full ${money0(bal)}</button><button type="button" class="chip" data-frac=".5">Half</button><button type="button" class="chip" data-frac=".25">25%</button></div></div>
      <div class="field"><label>Paid via</label><div class="chips" id="mch">${modes.map((x, i) => `<button type="button" class="chip ${i ? '' : 'on'}" data-mode="${x}">${x}</button>`).join('')}</div></div>
      <div class="grid g2"><div class="field"><label>Date</label><input type="date" name="paid_on" value="${todayStr()}" required></div><div class="field"><label>Reference / UTR</label><input name="reference" placeholder="optional"></div></div>
      <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save payment</button></div></form>`);
  const f = $('#qpf', m.el);
  let mode = modes[0];
  $$('[data-frac]', m.el).forEach((b) => (b.onclick = () => { f.amount.value = r2(bal * +b.dataset.frac); }));
  $$('[data-mode]', m.el).forEach((b) => (b.onclick = () => { mode = b.dataset.mode; $$('[data-mode]', m.el).forEach((x) => x.classList.toggle('on', x === b)); }));
  $('[data-x]', m.el).onclick = m.close;
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const upd = await api(`/invoices/${inv.id}/payments`, { method: 'POST', body: { amount: f.amount.value, paid_on: f.paid_on.value, mode, reference: f.reference.value } });
    m.close(); refreshBadge();
    const last = upd.payments.reduce((a, p) => (p.id > a.id ? p : a), upd.payments[0]);
    if (done) await done(upd);
    if (can('reminders.send')) askReceipt({ id: inv.id, client_id: inv.client_id || upd.client_id, client_name: inv.client_name }, last.id); else toast('Payment recorded');
  });
}
async function pickInvoiceForPayment(done) {
  const all_ = (await api('/invoices?type=tax')).filter((r) => r.balance_amount > 0.005).sort((a, b) => (a.due_date || '9').localeCompare(b.due_date || '9'));
  const m = modal(`<h2>Which invoice was paid?</h2><div class="inwrap" style="margin-bottom:10px">${ic('search', 18)}<input id="pq" placeholder="Search client or invoice number" autocomplete="off"></div><div class="rows pick" id="pl"></div>`);
  const draw = () => {
    const q = $('#pq', m.el).value.toLowerCase();
    const list = all_.filter((r) => !q || (r.client_name + r.invoice_number).toLowerCase().includes(q)).slice(0, 30);
    $('#pl', m.el).innerHTML = list.length ? list.map((r) => `<div class="ri" data-i="${r.id}">${avatar(r.client_name)}<div class="mid"><div class="t">${esc(r.client_name)}</div><div class="s">${esc(r.invoice_number)} · due ${dmy(r.due_date)}</div></div><div class="end"><div class="amt">${money0(r.balance_amount)}</div>${daysLate(r.due_date) > 0 ? `<div class="st bad">Overdue ${daysLate(r.due_date)}d</div>` : ''}</div></div>`).join('') : '<div class="empty">No unpaid invoices found.</div>';
    $$('[data-i]', m.el).forEach((n) => (n.onclick = () => { m.close(); quickPay(all_.find((r) => r.id === +n.dataset.i), done); }));
  };
  $('#pq', m.el).oninput = draw; draw(); setTimeout(() => $('#pq', m.el)?.focus(), 50);
}

// Ctrl+K / "/" search across invoices, clients, pages and actions
async function openSearch() {
  if ($('.sp')) return;
  const clients = await api('/clients').catch(() => []);
  const m = modal(`<div class="sp"><div class="inwrap">${ic('search', 18)}<input id="sq" placeholder="Search invoices, clients, pages…" autocomplete="off"></div><div class="sp-r" id="sr"></div></div>`);
  const acts = [
    can('invoices.create') && { ic: 'plus', t: 'New tax invoice', h: '#/invoices/new?type=tax' },
    can('invoices.create') && { ic: 'file', t: 'New proforma invoice', h: '#/invoices/new?type=proforma' },
    can('payments.create') && { ic: 'rupee', t: 'Record a payment', fn: () => pickInvoiceForPayment(() => route()) },
    can('clients.create') && { ic: 'users', t: 'Add client', fn: () => crudForm(CFG.clients, null, () => route()) },
  ].filter(Boolean);
  const pages = NAV.filter((n) => !n.perm || can(n.perm)).map((n) => ({ ic: n.icon, t: n.label, h: n.hash, s: 'Go to page' }));
  let cur = [], idx = 0, seq = 0;
  const paint = () => {
    $('#sr', m.el).innerHTML = cur.length ? cur.map((r, i) => `<div class="sr-i ${i === idx ? 'on' : ''}" data-i="${i}"><span class="sr-ic">${ic(r.ic, 17)}</span><div class="mid"><div class="t">${esc(r.t)}</div>${r.s ? `<div class="s">${esc(r.s)}</div>` : ''}</div>${r.r ? `<b class="amt">${r.r}</b>` : ''}</div>`).join('') : '<div class="empty">Nothing found.</div>';
    $$('.sr-i', m.el).forEach((n) => (n.onclick = () => go(cur[+n.dataset.i])));
  };
  const go = (r) => { m.close(); if (r.fn) r.fn(); else location.hash = r.h; };
  const run_ = async () => {
    const q = $('#sq', m.el).value.trim().toLowerCase(), my = ++seq;
    let out = [];
    if (!q) out = [...acts, ...pages.slice(0, 5)];
    else {
      out = acts.filter((a) => a.t.toLowerCase().includes(q));
      out.push(...pages.filter((p) => p.t.toLowerCase().includes(q)).slice(0, 3));
      out.push(...clients.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 4).map((c) => ({ ic: 'user', t: c.name, s: 'Client · view invoices', h: '#/invoices?client_id=' + c.id })));
      if (q.length >= 2) {
        const inv = await api('/invoices?q=' + encodeURIComponent(q)).catch(() => []);
        if (my !== seq) return;
        out.push(...inv.slice(0, 6).map((i) => ({ ic: 'file', t: i.invoice_number, s: `${i.client_name} · ${dmy(i.invoice_date)}`, r: money0(i.net_amount), h: '#/invoices/' + i.id })));
      }
    }
    cur = out; idx = 0; paint();
  };
  $('#sq', m.el).oninput = run_;
  $('#sq', m.el).onkeydown = (e) => {
    if (e.key === 'ArrowDown') { idx = Math.min(cur.length - 1, idx + 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); paint(); e.preventDefault(); }
    else if (e.key === 'Enter' && cur[idx]) go(cur[idx]);
    else if (e.key === 'Escape') m.close();
  };
  run_(); setTimeout(() => $('#sq', m.el)?.focus(), 50);
}
document.addEventListener('keydown', (e) => {
  if (!S.user || e.target.closest('input,textarea,select')) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.user) { e.preventDefault(); openSearch(); } return; }
  if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || e.key === '/') { e.preventDefault(); openSearch(); }
});

/* ------------------------------------------------------------ revenue dashboard (v4) */
async function viewDashboard(el) {
  const [f, t] = dashRange.key === 'custom' && dashRange.from ? [dashRange.from, dashRange.to] : RANGES[dashRange.key][1]();
  const d = await api(`/dashboard?from=${f}&to=${t}`);
  const pct = d.billed.total > 0 ? Math.min(100, Math.round((d.collected / d.billed.total) * 100)) : 0;
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const weekSum = d.dueWeek.reduce((s, i) => s + i.balance_amount, 0);
  const tile = (icn, tone, label, val, sub) => `<div class="stat ${tone}"><span class="stat-ic">${ic(icn, 19)}</span><div class="stat-b"><div class="stat-l">${label}</div><div class="stat-v">${val}</div><div class="stat-s">${sub}</div></div></div>`;
  el.innerHTML = `
    <div class="pagehead dash-head"><div><div class="eyebrow">${greet}, ${esc((S.user.name || '').split(' ')[0])}</div><h1 class="keep">Your money at a glance</h1></div>
      <div class="row"><select id="rk" aria-label="Period" class="pillsel">${Object.entries(RANGES).map(([k, v]) => `<option value="${k}" ${k === dashRange.key ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
        ${can('dashboard.export') ? `<button class="btn" id="ex">${ic('download')} Export</button>` : ''}</div></div>
    <div class="row hidden" id="cr" style="margin-bottom:14px"><input type="date" id="cf" value="${f}" style="width:auto"><span>to</span><input type="date" id="ct" value="${t}" style="width:auto"><button class="btn sm primary" id="cg">Apply</button></div>
    ${S.user.isAdmin ? '<div id="adm"></div>' : ''}
    <div class="dg">
      <section class="hero c7"><div class="hero-l"><div class="hero-k">Total outstanding</div><div class="hero-v">${money0(d.receivable.s)}</div>
          <div class="hero-s">across ${d.receivable.n} unpaid invoice${d.receivable.n === 1 ? '' : 's'}</div>
          <div class="hero-chips">${d.overdue.n ? `<span class="hchip bad">${d.overdue.n} overdue · ${money0(d.overdue.s)}</span>` : '<span class="hchip">Nothing overdue</span>'}${weekSum ? `<span class="hchip">${money0(weekSum)} due this week</span>` : ''}</div>
          <div class="hero-btns">${can('payments.create') ? `<button class="hbtn solid icon" id="qpay" title="Record payment" aria-label="Record payment">${ic('rupee', 21)}</button>` : ''}${can('reminders.view') ? `<a class="hbtn icon" href="#/reminders" title="Send reminders" aria-label="Send reminders">${ic('bell', 21)}</a>` : ''}</div></div>
        <div class="hero-r">${ring(pct, 118, 12, '#fff', 'rgba(255,255,255,.22)', '#fff')}<div class="hero-rl">of billed amount<br>collected</div></div></section>
      <div class="c5 stats">${tile('file', 'grey', 'Billed', money0(d.billed.total), `${d.billed.n} invoices${d.billed.credits ? ` · credits −${money0(d.billed.credits)}` : ''}`)}
        ${tile('check', 'ok', 'Collected', money0(d.collected), `${pct}% of billed`)}
        ${tile('clock', 'bad', 'Overdue', money0(d.overdue.s), `${d.overdue.n} past due date`)}
        ${tile('wallet', d.net >= 0 ? 'brand' : 'bad', 'Net after expenses', money0(d.net), `expenses ${money0(d.expenses.total)}`)}</div>
      <div class="qa c12">${can('invoices.create') ? `<a class="qa-i" href="#/invoices/new?type=tax"><span>${ic('plus', 18)}</span>New invoice</a>` : ''}${can('payments.create') ? `<button class="qa-i" id="qp2"><span>${ic('rupee', 18)}</span>Record payment</button>` : ''}
        ${can('clients.create') ? `<button class="qa-i" id="qc"><span>${ic('users', 18)}</span>Add client</button>` : ''}${can('expenses.create') ? `<button class="qa-i" id="qe"><span>${ic('wallet', 18)}</span>Add expense</button>` : ''}
        ${can('reminders.view') ? `<a class="qa-i" href="#/reminders"><span>${ic('bell', 18)}</span>Reminders</a>` : ''}<a class="qa-i" href="#/payments"><span>${ic('chart', 18)}</span>All payments</a></div>
      <section class="card c8"><div class="row sp"><h2>Billed vs collected</h2><div class="legend"><span><i style="background:var(--c1)"></i>Billed</span><span><i style="background:var(--c2)"></i>Collected</span></div></div>${chart(d.monthly)}</section>
      <section class="card c4"><h2>Due this week</h2>${d.dueWeek.length ? `<div class="mrows">${d.dueWeek.map((i) => { const left = -daysLate(i.due_date); return `<div class="mr-i" data-open="${i.id}">${avatar(i.client_name, 'sm')}<div class="mid"><div class="t">${esc(i.client_name)}</div><div class="s">${esc(i.invoice_number)} · ${left <= 0 ? 'due today' : 'in ' + left + ' day' + (left === 1 ? '' : 's')}</div></div><div class="end"><b>${money0(i.balance_amount)}</b>${can('payments.create') ? `<button class="mini" data-qp="${i.id}">Paid</button>` : ''}</div></div>`; }).join('')}</div>` : '<div class="empty">Nothing due in the next 7 days.</div>'}</section>
      <section class="card c7"><div class="row sp"><h2>Recent payments</h2><a class="small" href="#/payments">See all →</a></div>${d.recentPayments.length ? `<div class="mrows">${d.recentPayments.map((p) => `<div class="mr-i" data-open="${p.invoice_id}">${avatar(p.client_name, 'sm')}<div class="mid"><div class="t">${esc(p.client_name)}</div><div class="s">${esc(p.invoice_number)} · ${fmtLong(p.paid_on)}${p.mode ? ' · ' + esc(p.mode) : ''}</div></div><div class="end"><b class="pos">+ ${money0(p.amount)}</b></div></div>`).join('')}</div>` : '<div class="empty">No payments recorded yet.</div>'}</section>
      <section class="card c5"><h2>Overdue ageing</h2>${aging(d.aging)}</section>
      <section class="card c4"><h2>Top clients</h2>${d.topClients.length ? `<div class="mrows">${d.topClients.map((c, i) => `<a class="mr-i" href="#/invoices?client_id=${c.client_id}"><span class="rank r${i + 1}">${i + 1}</span><div class="mid"><div class="t">${esc(c.name)}</div><div class="s">${c.invoices} invoice(s) · pending ${money0(c.pending)}</div></div><div class="end"><b>${money0(c.billed)}</b></div></a>`).join('')}</div>` : '<div class="empty">No invoices in this period.</div>'}</section>
      <section class="card c4"><h2>Slowest payers</h2>${d.slowPayers.length ? `<div class="mrows">${d.slowPayers.map((c) => `<a class="mr-i" href="#/invoices?client_id=${c.client_id}">${avatar(c.name, 'sm')}<div class="mid"><div class="t">${esc(c.name)}</div><div class="s">${c.invoices} paid invoice(s)${c.overdue ? ` · overdue ${money0(c.overdue)}` : ''}</div></div><div class="end"><b>${c.avg_days} days</b></div></a>`).join('')}</div><div class="small muted" style="margin-top:8px">Average days from invoice to final payment.</div>` : '<div class="empty">Shows once invoices get paid.</div>'}</section>
      <section class="card c4"><h2>Cash snapshot</h2><div class="snap"><div><span>Collected</span><b class="pos">${money0(d.collected)}</b></div><div><span>Expenses</span><b>− ${money0(d.expenses.total)}</b></div><div class="tot"><span>Net</span><b style="color:${d.net >= 0 ? 'var(--ok)' : 'var(--bad)'}">${money0(d.net)}</b></div></div>
        ${d.expenses.byCategory.map((c) => `<div class="small muted snap-c"><span>${esc(c.category)}</span><span>${money0(c.s)}</span></div>`).join('')}${can('expenses.view') ? '<a class="small" href="#/expenses">Manage expenses →</a>' : ''}</section>
    </div>
    ${d.proforma.n ? `<p class="muted small">${d.proforma.n} proforma invoice(s) worth ${money0(d.proforma.s)} not yet converted — not counted above.</p>` : ''}`;
  const custom = () => $('#cr').classList.toggle('hidden', $('#rk').value !== 'custom');
  custom();
  $('#rk').onchange = () => { dashRange.key = $('#rk').value; if (dashRange.key === 'custom') custom(); else viewDashboard(el); };
  $('#cg').onclick = () => { dashRange = { key: 'custom', from: $('#cf').value, to: $('#ct').value }; viewDashboard(el); };
  if ($('#ex')) $('#ex').onclick = () => download(`/export/revenue.csv?from=${f}&to=${t}`, `revenue_${f}_to_${t}.csv`);
  const again = () => viewDashboard(el);
  ['#qpay', '#qp2'].forEach((s) => { if ($(s, el)) $(s, el).onclick = () => pickInvoiceForPayment(again); });
  if ($('#qc', el)) $('#qc', el).onclick = () => crudForm(CFG.clients, null, () => toast('Client added'));
  if ($('#qe', el)) $('#qe', el).onclick = () => crudForm(CFG.expenses, null, again);
  $$('[data-qp]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const i = d.dueWeek.find((x) => x.id === +b.dataset.qp); quickPay(i, again); }));
  $$('[data-open]', el).forEach((n) => (n.onclick = () => (location.hash = '#/invoices/' + n.dataset.open)));
  if ($('#adm', el)) adminPanel($('#adm', el));
}

function aging(a) {
  const rows = [['Not yet due', a.current, 'var(--ok)'], ['1–30 days', a.d30, 'var(--warn)'], ['31–60 days', a.d60, '#e07a2f'], ['60+ days', a.d90, 'var(--bad)']];
  const total = rows.reduce((s, r) => s + r[1], 0);
  if (!total) return '<div class="empty">Nothing outstanding.</div>';
  return `<div class="bars">${rows.map((r) => `<span style="width:${(r[1] / total) * 100}%;background:${r[2]}"></span>`).join('')}</div>` +
    rows.map((r) => `<div class="list-line"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${r[2]};margin-right:8px"></i>${r[0]}</span><b>${money(r[1])}</b></div>`).join('');
}
function chart(months) {
  // phones: fit up to 12 months in the card width; longer ranges scroll sideways instead of cramming labels
  const mob = mobile(), H = 200, L = 44, B = 24, T = 8, ph = H - B - T, W = mob ? Math.max(340, L + months.length * 23) : Math.max(320, months.length * 46);
  const max = Math.max(1, ...months.flatMap((m) => [m.billed, m.collected]));
  const step = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / step) * step;
  const bw = (W - L) / months.length;
  const y = (v) => T + ph - (v / top) * ph;
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = (top / 4) * i; g += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`; }
  const bars = months.map((m, i) => {
    const x = L + i * bw + bw * 0.14, w = bw * 0.36;
    const lbl = new Date(m.month + '-01T00:00:00').toLocaleString('en-IN', { month: 'short' }).slice(0, 3);
    return `<rect x="${x}" y="${y(m.billed)}" width="${w}" height="${T + ph - y(m.billed)}" rx="3" fill="var(--c1)"><title>${m.month} billed ${money(m.billed)}</title></rect>
      <rect x="${x + w + 2}" y="${y(m.collected)}" width="${w}" height="${T + ph - y(m.collected)}" rx="3" fill="var(--c2)"><title>${m.month} collected ${money(m.collected)}</title></rect>
      <text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${lbl}</text>`;
  }).join('');
  return `<div style="overflow-x:auto"><svg class="chart ${mob ? 'mob' : ''}" viewBox="0 0 ${W} ${H}" style="min-width:${mob ? (W > 340 ? W : 0) : Math.min(W, 560)}px" role="img" aria-label="Monthly billed and collected">${g}${bars}</svg></div>`;
}

/* ------------------------------------------------------------ message modal (WhatsApp / email, manual send) */
let TPL_CACHE = null;
const mailVia = () => { try { return localStorage.getItem('mailVia') || 'gmail'; } catch { return 'gmail'; } };
async function openMessage({ client_id, invoice_id, payment_id, kind, channel, rule }) {
  const tpls = (TPL_CACHE = await api('/messages/templates')).filter((t) => (!kind || t.kind === kind) && (!channel || t.channel === channel) && (invoice_id || !/\{\{\s*(invoice_number|invoice_date|due_date|invoice_total|invoice_balance|days_overdue|invoice_link|payment_)/.test(t.body + (t.subject || ''))));
  if (!tpls.length) return toast('No templates yet — create one in Templates.', true);
  const m = modal(`<h2>${channel === 'email' ? 'Send email' : channel === 'whatsapp' ? 'Send WhatsApp message' : 'Send message'}</h2>
    <div class="stack"><div class="field"><label>Template</label><select id="mt">${tpls.map((t) => `<option value="${t.id}">${t.channel === 'email' ? 'Email' : 'WhatsApp'} · ${esc(t.name)}</option>`).join('')}</select></div>
    <div class="field hidden" id="msw"><label>Subject</label><input id="ms"></div>
    <div class="field"><label>Message (edit before sending)</label><textarea id="mb" rows="9"></textarea></div>
    <div class="small muted" id="mi"></div></div>
    <div class="mail-via hidden" id="mv"><span class="small muted">Open in</span>
      <button type="button" class="btn sm" data-via="gmail">Gmail</button><button type="button" class="btn sm" data-via="outlook">Outlook</button><button type="button" class="btn sm" data-via="app">Mail app</button></div>
    <div class="actions"><button class="btn" id="mc">${invoice_id ? `${ic('copy')} Copy image` : 'Copy text'}</button><button class="btn" id="mx">Close</button><button class="btn primary" id="mg">Open</button></div>`);
  let cur = null;
  const load = guard(async () => {
    const id = +$('#mt', m.el).value;
    cur = await api('/messages/render', { method: 'POST', body: { template_id: id, client_id, invoice_id, payment_id } });
    cur.template_id = id;
    $('#mb', m.el).value = cur.text; $('#ms', m.el).value = cur.subject;
    $('#msw', m.el).classList.toggle('hidden', cur.channel !== 'email');
    $('#mi', m.el).textContent = cur.channel === 'email' ? (cur.to_email ? `To: ${cur.to_email}` : 'This client has no email saved.') : (cur.mobile ? `To: +${cur.mobile}` : 'This client has no mobile number — you can pick the contact in WhatsApp.');
    $('#mv', m.el).classList.toggle('hidden', cur.channel !== 'email');
    $$('[data-via]', m.el).forEach((b) => b.classList.toggle('on', b.dataset.via === mailVia()));
    $('#mg', m.el).textContent = cur.channel === 'email' ? `Open in ${{ gmail: 'Gmail', outlook: 'Outlook', app: 'mail app' }[mailVia()]}` : 'Open WhatsApp';
    $('#mg', m.el).className = 'btn ' + (cur.channel === 'email' ? 'primary' : 'wa');
  });
  $('#mt', m.el).onchange = load; load();
  $$('[data-via]', m.el).forEach((b) => (b.onclick = () => { try { localStorage.setItem('mailVia', b.dataset.via); } catch {} load(); }));
  $('#mx', m.el).onclick = m.close;
  // with an invoice in play, share the invoice picture (paste it in WhatsApp / email); a client-level reminder has no single invoice, so it copies text
  $('#mc', m.el).onclick = invoice_id
    ? () => copyInvoiceImage(api('/invoices/' + invoice_id))
    : () => navigator.clipboard?.writeText($('#mb', m.el).value).then(() => toast('Copied'), () => toast('Copy failed', true));
  $('#mg', m.el).onclick = guard(async () => {
    const text = $('#mb', m.el).value, enc = encodeURIComponent;
    let url;
    const subj = $('#ms', m.el).value, via = mailVia();
    // Gmail / Outlook open a compose window in the browser; "mail app" needs a default mail program on the computer
    if (cur.channel === 'email' && via === 'gmail') url = `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(cur.to_email)}&su=${enc(subj)}&body=${enc(text)}${cur.cc ? `&cc=${enc(cur.cc)}` : ''}`;
    else if (cur.channel === 'email' && via === 'outlook') url = `https://outlook.office.com/mail/deeplink/compose?to=${enc(cur.to_email)}&subject=${enc(subj)}&body=${enc(text)}${cur.cc ? `&cc=${enc(cur.cc)}` : ''}`;
    else if (cur.channel === 'email') url = `mailto:${enc(cur.to_email)}?subject=${enc(subj)}&body=${enc(text)}${cur.cc ? `&cc=${enc(cur.cc)}` : ''}`;
    else url = `https://wa.me/${cur.mobile || ''}?text=${enc(text)}`;
    if (can('reminders.send')) await api('/messages/log', { method: 'POST', body: { client_id: client_id || null, invoice_id: invoice_id || null, channel: cur.channel, template_id: cur.template_id, rule } }).catch(() => {});
    if (url.startsWith('mailto:')) location.href = url; else window.open(url, '_blank', 'noopener');
    toast(url.startsWith('mailto:') ? 'If nothing opened, pick Gmail or Outlook instead' : 'Opened — press send there');
    m.close();
    refreshBadge();
    if (location.hash === '#/reminders') route();
  });
}

/* ------------------------------------------------------------ reminders */
async function viewReminders(el) {
  const [list, queue, rules] = await Promise.all([api('/reminders'), api('/reminders/queue'), api('/reminders/rules')]);
  const total = r2(list.reduce((s, c) => s + c.total_pending, 0));
  const cnt = list.reduce((s, c) => s + c.pending_count, 0), over = list.reduce((s, c) => s + c.overdue_count, 0);
  const pgQ = paginate('rem-queue', queue), pgC = paginate('rem-clients', list);
  el.innerHTML = `<div class="pagehead"><div><h1>Payment reminders</h1><div class="muted small">Clients with pending tax invoices. Buttons open WhatsApp / your email app with a message from your templates.</div></div>
      ${can('templates.view') ? '<a class="btn" href="#/templates">Edit templates</a>' : ''}</div>
    <div class="grid g3"><div class="card kpi"><div class="label">Total pending</div><div class="val">${money(total)}</div><div class="sub">${cnt} invoice(s) · ${list.length} client(s)</div></div>
      <div class="card kpi ${over ? 'bad' : ''}"><div class="label">Overdue invoices</div><div class="val">${over}</div></div>
      <div class="card kpi"><div class="label">Not yet reminded</div><div class="val">${list.filter((c) => !c.last_reminded).length}</div></div></div>
    <div class="card" style="margin-top:14px"><div class="row sp"><div><h2>Send today <span class="pill ${queue.length ? 'overdue' : 'paid'}">${queue.length}</span></h2><div class="small muted">Reminders that your schedule says are due now. Tap to open the message — press send in WhatsApp / email.</div></div>
      ${can('reminders.send') ? '<button class="btn sm" id="er">Schedule</button>' : ''}</div>
      ${queue.length ? pgQ.rows.map((q) => `<div class="list-line"><div><b>${esc(q.client_name)}</b> · <a href="#/invoices/${q.id}">${esc(q.invoice_number)}</a><div class="small muted"><span class="pill ${q.diff > 0 ? 'overdue' : 'partial'}">${esc(q.label)}</span> ${money(q.balance_amount)}</div></div>
        ${can('reminders.send') ? `<div class="row"><button class="btn wa sm" data-qw="${q.id}">WhatsApp</button><button class="btn sm" data-qe="${q.id}">Email</button></div>` : ''}</div>`).join('') + pgQ.html : '<div class="empty">All caught up — no reminders due today.</div>'}</div>
    <div class="stack" style="margin-top:14px">${list.length ? pgC.rows.map((c) => `<div class="card">
      <div class="row sp"><div><h3>${esc(c.name)}</h3><div class="small muted">${esc(c.mobile || 'no mobile')} · ${esc(c.email || 'no email')}</div></div>
        <div class="right"><div style="font-size:19px;font-weight:700">${money(c.total_pending)}</div><div class="small muted">${c.pending_count} pending${c.overdue_count ? ` · <span style="color:var(--bad)">${c.overdue_count} overdue</span>` : ''}</div></div></div>
      <div style="margin:10px 0">${c.invoices.map((i) => `<div class="list-line small"><span><a href="#/invoices/${i.id}">${esc(i.invoice_number)}</a> ${i.days_overdue ? `<span class="pill overdue">${i.days_overdue}d overdue</span>` : `<span class="muted">due ${dmy(i.due_date)}</span>`}</span>
        <span class="row"><b>${money(i.balance_amount)}</b>${can('reminders.send') ? `<button class="btn sm" data-inv="${i.id}" data-c="${c.client_id}">Remind</button>` : ''}</span></div>`).join('')}</div>
      <div class="row sp"><span class="small muted">${c.last_reminded ? 'Last reminded ' + dmy(c.last_reminded) : 'Never reminded'}</span>
        ${can('reminders.send') ? `<span class="row"><button class="btn wa sm" data-wa="${c.client_id}">WhatsApp</button><button class="btn sm" data-em="${c.client_id}">Email</button></span>` : ''}</div>
    </div>`).join('') + pgC.html : '<div class="empty card">No pending payments.</div>'}</div>`;
  pgQ.bind(el, () => viewReminders(el)); pgC.bind(el, () => viewReminders(el));
  const qOf = (id) => queue.find((q) => q.id === +id);
  $$('[data-qw]', el).forEach((b) => (b.onclick = () => { const q = qOf(b.dataset.qw); openMessage({ client_id: q.client_id, invoice_id: q.id, kind: 'reminder', channel: 'whatsapp', rule: q.rule }); }));
  $$('[data-qe]', el).forEach((b) => (b.onclick = () => { const q = qOf(b.dataset.qe); openMessage({ client_id: q.client_id, invoice_id: q.id, kind: 'reminder', channel: 'email', rule: q.rule }); }));
  if ($('#er', el)) $('#er', el).onclick = () => {
    const m = modal(`<h2>Reminder schedule</h2><p class="muted small">Days relative to the due date. <b>-3</b> = 3 days before, <b>0</b> = on the due date, <b>7</b> = a week overdue. Each invoice gets a reminder in the queue once per step.</p>
      <form class="stack"><div class="field"><label>Days (comma separated)</label><input name="r" value="${rules.rules.join(', ')}"></div><div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`);
    $('[data-x]', m.el).onclick = m.close;
    $('form', m.el).onsubmit = guard(async (e) => { e.preventDefault(); await api('/reminders/rules', { method: 'PUT', body: { rules: e.target.r.value.split(',').map((x) => x.trim()).filter(Boolean).map(Number) } }); m.close(); toast('Schedule saved'); refreshBadge(); viewReminders(el); });
  };
  $$('[data-wa]', el).forEach((b) => (b.onclick = () => openMessage({ client_id: +b.dataset.wa, kind: 'reminder', channel: 'whatsapp' })));
  $$('[data-em]', el).forEach((b) => (b.onclick = () => openMessage({ client_id: +b.dataset.em, kind: 'reminder', channel: 'email' })));
  $$('[data-inv]', el).forEach((b) => (b.onclick = () => openMessage({ client_id: +b.dataset.c, invoice_id: +b.dataset.inv, kind: 'reminder' })));
}

/* ------------------------------------------------------------ invoices list */
/* ------------------------------------------------------------ invoices list (v4) */
const STATUS_TXT = { paid: ['Paid', 'ok'], overdue: ['Overdue', 'bad'], partial: ['Partial', 'warn'], unpaid: ['Unpaid', 'mut'], proforma: ['Proforma', 'warn'] };
function invStatus(r) {
  const k = statKey(r);
  if (k === 'proforma') return r.converted_to_id ? ['Converted', 'ok'] : ['Proforma', 'warn'];
  if (k === 'overdue') return [`Overdue ${daysLate(r.due_date)}d`, 'bad'];
  if (k === 'partial') return [`${money0(r.balance_amount)} left`, 'warn'];
  return STATUS_TXT[k];
}
const canPay = (r) => r.invoice_type === 'tax' && r.balance_amount > 0.005 && can('payments.create');
function invRowsMobile(rows) {
  return `<div class="rows">${rows.map((r) => {
    const [txt, cls] = invStatus(r), pct = r.net_amount > 0 ? Math.min(100, (r.paid_amount / r.net_amount) * 100) : 0;
    return `<div class="ri inv-ri" data-id="${r.id}">${avatar(r.client_name)}<div class="mid"><div class="row sp nowrap-r"><div class="t">${esc(r.client_name)}</div><div class="amt">${money0(r.net_amount)}</div></div>
      <div class="row sp nowrap-r"><div class="s">${esc(r.invoice_number)} · ${dmy(r.invoice_date)}</div><div class="st ${cls}">${txt}</div></div>
      ${r.invoice_type === 'tax' && r.paid_amount > 0 ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="s"><span class="pos">${money0(r.paid_amount)} received</span> · ${money0(r.balance_amount)} pending</div>` : ''}
      ${canPay(r) ? `<button class="mini solid" data-pay="${r.id}">Record payment</button>` : ''}</div></div>`;
  }).join('')}</div>`;
}
function invTable(rows) {
  return `<div class="card tbl-card"><table class="tbl"><thead><tr><th>Invoice</th><th>Dates</th><th class="num">Amount</th><th style="width:22%">Payment</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((r) => {
      const [txt, cls] = invStatus(r), tax = r.invoice_type === 'tax', pct = r.net_amount > 0 ? Math.min(100, (r.paid_amount / r.net_amount) * 100) : 0;
      return `<tr class="click" data-id="${r.id}"><td><div class="cell-who">${avatar(r.client_name, 'sm')}<div><div class="t">${esc(r.client_name)}</div><div class="s">${esc(r.invoice_number)}${tax ? '' : ' <span class="pill proforma">Proforma</span>'}</div></div></div></td>
        <td><div>${fmtLong(r.invoice_date)}</div><div class="s ${cls === 'bad' ? 'bad' : ''}">${r.due_date ? 'Due ' + fmtLong(r.due_date) : ''}</div></td>
        <td class="num"><b>${money(r.net_amount)}</b></td>
        <td>${tax ? `<div class="paycell"><div class="pc-t"><span class="pos">${money0(r.paid_amount)}</span><span class="muted"> of ${money0(r.net_amount)}</span></div><div class="prog slim"><span style="width:${pct}%"></span></div>${r.balance_amount > 0.005 ? `<div class="s bad">${money0(r.balance_amount)} pending</div>` : '<div class="s pos">Fully paid</div>'}</div>` : '<span class="muted">—</span>'}</td>
        <td><span class="st-pill ${cls}">${txt}</span></td>
        <td class="right">${canPay(r) ? `<button class="mini solid" data-pay="${r.id}">Record payment</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}
let invFilter = { status: '', q: '' };
async function viewInvoices(el, m, q) {
  const params = new URLSearchParams();
  if (q.client_id) params.set('client_id', q.client_id);
  if (invFilter.q) params.set('q', invFilter.q);
  const all_ = await api('/invoices?' + params);
  const tax = all_.filter((r) => r.invoice_type === 'tax');
  const sum = { billed: tax.reduce((s, r) => s + r.net_amount, 0), paid: tax.reduce((s, r) => s + r.paid_amount, 0), pend: tax.reduce((s, r) => s + Math.max(0, r.balance_amount), 0) };
  const cnt = { '': all_.length }; for (const r of all_) cnt[statKey(r)] = (cnt[statKey(r)] || 0) + 1;
  const rows = invFilter.status ? all_.filter((r) => statKey(r) === invFilter.status) : all_;
  const pgk = 'inv:' + (q.client_id || ''), pg = paginate(pgk, rows);
  const tabs = [['', 'All'], ['unpaid', 'Unpaid'], ['partial', 'Partial'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['proforma', 'Proforma']];
  el.innerHTML = `<div class="pagehead"><div><h1>Invoices</h1><div class="muted small">${q.client_id && all_[0] ? esc(all_[0].client_name) + ' · ' : ''}${all_.length} total</div></div><div class="row">
      ${can('invoices.export') ? `<button class="btn" id="ex">${ic('download')} Export</button>` : ''}
      ${can('invoices.create') ? `<a class="btn" href="#/invoices/new?type=proforma">Proforma</a><a class="btn primary" href="#/invoices/new?type=tax">${ic('plus')} New invoice</a>` : ''}</div></div>
    <div class="sumstrip"><div class="ss"><span>Billed</span><b>${money0(sum.billed)}</b></div><div class="ss ok"><span>Received</span><b>${money0(sum.paid)}</b></div><div class="ss bad"><span>Pending</span><b>${money0(sum.pend)}</b></div>
      <div class="ss prog-ss"><span>${sum.billed > 0 ? Math.round((sum.paid / sum.billed) * 100) : 0}% collected</span><div class="prog"><span style="width:${sum.billed > 0 ? Math.min(100, (sum.paid / sum.billed) * 100) : 0}%"></span></div></div></div>
    <div class="filterbar"><div class="tabs">${tabs.map(([v, l]) => `<button class="tab ${invFilter.status === v ? 'on' : ''}" data-s="${v}">${l}<i>${cnt[v] || 0}</i></button>`).join('')}</div>
      <div class="inwrap grow-in">${ic('search', 17)}<input id="fq" placeholder="Search client or invoice number" value="${esc(invFilter.q)}"></div>${q.client_id ? '<a class="pill" href="#/invoices">clear client ×</a>' : ''}</div>
    ${rows.length ? (mobile() ? invRowsMobile(pg.rows) : invTable(pg.rows)) + pg.html : '<div class="empty card">No invoices match.</div>'}`;
  pg.bind(el, () => viewInvoices(el, m, q));
  $$('.tab', el).forEach((b) => (b.onclick = () => { invFilter.status = b.dataset.s; resetPg(pgk); viewInvoices(el, m, q); }));
  let tm; $('#fq', el).oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => { invFilter.q = e.target.value; resetPg(pgk); viewInvoices(el, m, q).then(() => { const i = $('#fq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300); };
  $$('tr.click, .ri[data-id]', el).forEach((r) => (r.onclick = () => (location.hash = '#/invoices/' + r.dataset.id)));
  $$('[data-pay]', el).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); quickPay(all_.find((r) => r.id === +b.dataset.pay), () => viewInvoices(el, m, q)); }));
  if ($('#ex', el)) $('#ex', el).onclick = () => download('/export/invoices.csv', 'invoices.csv');
}

/* ------------------------------------------------------------ payments ledger */
let payRange = { key: 'month', from: null, to: null };
async function viewPayments(el) {
  const R = { month: ['This month', () => monthBounds(0)], lmonth: ['Last month', () => monthBounds(-1)], fy: ['This financial year', () => fyBounds(0)], all: ['All time', () => ['2000-01-01', '2100-12-31']], custom: ['Custom range', null] };
  const [f, t] = payRange.key === 'custom' && payRange.from ? [payRange.from, payRange.to] : R[payRange.key][1]();
  const d = await api(`/payments?from=${f}&to=${t}`);
  const pg = paginate('pay', d.rows), groups = {}, dayTot = {};
  for (const r of d.rows) dayTot[r.paid_on] = (dayTot[r.paid_on] || 0) + r.amount;
  for (const r of pg.rows) (groups[r.paid_on] ||= []).push(r);
  const modeTot = Object.entries(d.byMode).sort((a, b) => b[1] - a[1]);
  const dayLabel = (s) => (s === todayStr() ? 'Today' : s === ymd(new Date(Date.now() - 864e5)) ? 'Yesterday' : fmtLong(s));
  el.innerHTML = `<div class="pagehead"><div><h1>Payments received</h1><div class="muted small">Every rupee that came in, with the invoice it belongs to.</div></div>
      <div class="row"><select id="pk" class="pillsel">${Object.entries(R).map(([k, v]) => `<option value="${k}" ${k === payRange.key ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      ${can('payments.create') ? `<button class="btn primary" id="np">${ic('plus')} Record payment</button>` : ''}</div></div>
    <div class="row hidden" id="pcr" style="margin-bottom:14px"><input type="date" id="pf" value="${f}" style="width:auto"><span>to</span><input type="date" id="pt" value="${t}" style="width:auto"><button class="btn sm primary" id="pg">Apply</button></div>
    <div class="sumstrip"><div class="ss ok"><span>Received</span><b>${money0(d.total)}</b></div><div class="ss"><span>Payments</span><b>${d.rows.length}</b></div>
      ${modeTot.slice(0, 3).map(([m, v]) => `<div class="ss"><span>${esc(m)}</span><b>${money0(v)}</b></div>`).join('')}</div>
    ${d.rows.length ? Object.entries(groups).map(([day, list]) => `<div class="day-h"><span>${dayLabel(day)}</span><span>${money0(dayTot[day])}</span></div><div class="rows">${list.map((r) => `<div class="ri" data-id="${r.invoice_id}">${avatar(r.client_name)}<div class="mid"><div class="t">${esc(r.client_name)}</div><div class="s">${esc(r.invoice_number)}${r.mode ? ' · ' + esc(r.mode) : ''}${r.reference ? ' · ' + esc(r.reference) : ''}</div></div><div class="end"><div class="amt pos">+ ${money(r.amount)}</div><div class="st ${r.balance_amount > 0.005 ? 'warn' : 'ok'}">${r.balance_amount > 0.005 ? money0(r.balance_amount) + ' still pending' : 'Invoice cleared'}</div></div></div>`).join('')}</div>`).join('') + pg.html : '<div class="empty card">No payments in this period.</div>'}`;
  pg.bind(el, () => viewPayments(el));
  const cust = () => $('#pcr').classList.toggle('hidden', $('#pk').value !== 'custom');
  cust();
  $('#pk').onchange = () => { payRange.key = $('#pk').value; resetPg('pay'); if (payRange.key === 'custom') cust(); else viewPayments(el); };
  $('#pg').onclick = () => { resetPg('pay'); payRange = { key: 'custom', from: $('#pf').value, to: $('#pt').value }; viewPayments(el); };
  $$('.ri[data-id]', el).forEach((n) => (n.onclick = () => (location.hash = '#/invoices/' + n.dataset.id)));
  if ($('#np', el)) $('#np', el).onclick = () => pickInvoiceForPayment(() => viewPayments(el));
}


/* ------------------------------------------------------------ invoice form */
const stateOf = (p) => (/^\d{2}/.test(p?.gst_number || '') ? p.gst_number.slice(0, 2) : p?.state_code || '');
async function viewInvoiceForm(el, id, q = {}) {
  const [clients, products, inv] = await Promise.all([
    api('/clients'), api('/products').catch(() => []), id ? api('/invoices/' + id) : null,
  ]);
  const orgs = S.meta.organisations;
  if (!orgs.length) { el.innerHTML = '<div class="empty card">Add an organisation in Settings first.</div>'; return; }
  const st = {
    type: inv ? inv.invoice_type : q.type === 'proforma' ? 'proforma' : 'tax',
    clientId: inv?.client_id || (q.client_id ? +q.client_id : null),
    gst: inv ? !!inv.gst_applied : true,
    pay: inv ? { qr: !!inv.pay_qr, upi: !!inv.pay_upi, bank: !!inv.pay_bank } : { qr: true, upi: true, bank: true },
    items: inv ? inv.items.map((i) => ({ ...i })) : [{ quantity: 1, price: 0, tax: 18, discount_percent: 0, description: '' }],
  };
  const due = inv?.due_date || ymd(new Date(Date.now() + 7 * 864e5));
  const canClient = can('clients.create'), canProduct = can('products.create');
  const clientOpts = () => `<option value="">Select client…</option>${clients.map((c) => `<option value="${c.id}" ${st.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}${canClient ? '<option value="__new">＋ Add new client…</option>' : ''}`;
  const productOpts = (sel) => `<option value="">Custom item</option>${products.map((p) => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}${canProduct ? '<option value="__new">＋ Add new service…</option>' : ''}`;

  el.innerHTML = `<div class="pagehead"><div><a href="${inv ? '#/invoices/' + id : '#/invoices'}" class="small">← Back</a><h1>${inv ? 'Edit ' + esc(inv.invoice_number) : 'New invoice'}</h1></div>
    ${inv ? '' : `<div class="seg" role="tablist"><button type="button" data-ty="tax">Tax invoice</button><button type="button" data-ty="proforma">Proforma</button></div>`}</div>
    <form id="f"><div class="formgrid"><div class="stack">
      <div class="card"><div class="step-h"><span class="hd-icon">${ic('user', 15)}</span><h2>Bill to</h2></div>
        <div class="grid g2"><div class="field"><label>Client</label><div class="inline-add"><select id="cl" required>${clientOpts()}</select>${canClient ? '<button type="button" class="btn" id="nc" title="Add new client">＋ New</button>' : ''}</div></div>
        <div class="field"><label>Billing organisation</label><select id="org">${orgs.map((o) => `<option value="${o.id}" ${inv?.organisation_id === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div></div>
        <div class="partybox hidden" id="pb"></div></div>
      <div class="card"><div class="step-h"><span class="hd-icon">${ic('percent', 15)}</span><h2>Tax &amp; payment</h2></div>
        <div class="field"><label>GST</label><div class="seg" id="gsts"><button type="button" data-g="1">With GST</button><button type="button" data-g="0">Without GST</button></div></div>
        <div class="field" style="margin-top:14px"><label>Payment options shown on the invoice</label><div class="payopts" id="po"></div></div></div>
      <div class="card"><div class="step-h"><span class="hd-icon">${ic('calendar', 15)}</span><h2>Details</h2></div>
        <div class="grid g3"><div class="field"><label>Invoice date</label><input type="date" id="dt" value="${inv?.invoice_date || todayStr()}" required></div>
        <div class="field"><label>Due date</label><input type="date" id="du" value="${due}"></div>
        <div class="field"><label>TDS %</label><input type="number" id="tds" min="0" max="100" step="0.01" inputmode="decimal" value="${inv?.tds_percent || 0}"></div></div></div>
      <div class="card"><div class="row sp step-h"><span class="row" style="gap:0"><span class="hd-icon">${ic('box', 15)}</span><h2>Items</h2></span><button type="button" class="btn sm" id="ai">+ Add line</button></div><div class="items" id="its"></div></div>
      <div class="card"><div class="field"><label>Notes / terms (printed on invoice)</label><textarea id="nt" rows="3">${esc(inv?.notes || '')}</textarea></div></div>
    </div>
    <aside class="summary card"><h2 style="margin-bottom:8px">Summary</h2><div class="small muted" id="tx"></div><div class="totals" id="tt" style="max-width:none"></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="sv" style="flex:1">${inv ? 'Save changes' : st.type === 'tax' ? 'Create tax invoice' : 'Create proforma'}</button></div></aside></div>
    <div class="savebar"><div><div class="small muted">Total</div><b id="sbt">₹0.00</b></div><button class="btn primary" id="sv2">${inv ? 'Save changes' : 'Create invoice'}</button></div></form>`;

  const setType = (t) => {
    st.type = t; $$('[data-ty]', el).forEach((b) => b.classList.toggle('on', b.dataset.ty === t));
    if (!inv) $('#sv').textContent = t === 'tax' ? 'Create tax invoice' : 'Create proforma';
  };
  $$('[data-ty]', el).forEach((b) => (b.onclick = () => setType(b.dataset.ty)));
  setType(st.type);

  const client = () => clients.find((c) => c.id === st.clientId);
  const org = () => orgs.find((o) => o.id === +$('#org').value);
  const intra = () => { const c = client(), o = org(); return !!c && !!stateOf(o) && stateOf(o) === stateOf(c); };
  const partybox = () => {
    const c = client(), pb = $('#pb');
    pb.classList.toggle('hidden', !c);
    if (c) pb.innerHTML = `<b>${esc(c.name)}</b><div class="muted">${[c.gst_number && 'GSTIN ' + esc(c.gst_number), c.mobile && esc(c.mobile), c.email && esc(c.email)].filter(Boolean).join(' · ') || 'No GSTIN / contact saved'}</div>`;
  };

  // pick a client / product created inline
  const addClient = () => crudForm(CFG.clients, null, (row) => { clients.push(row); st.clientId = row.id; $('#cl').innerHTML = clientOpts(); refresh(); });
  $('#cl').onchange = (e) => { if (e.target.value === '__new') { $('#cl').value = st.clientId || ''; addClient(); } else { st.clientId = +e.target.value || null; refresh(); } };
  if ($('#nc')) $('#nc').onclick = addClient;

  const drawItems = () => {
    $('#its').innerHTML = st.items.map((it, i) => `<div class="item" data-i="${i}">
      <div class="field desc"><label>Service / product</label><select data-k="pid">${productOpts(it.service_product_id)}</select>
        <input data-k="description" placeholder="Description" value="${esc(it.description)}"></div>
      <div class="field"><label>SAC</label><input data-k="sac_number" value="${esc(it.sac_number || '')}"></div>
      <div class="field"><label>Price</label><input type="number" inputmode="decimal" data-k="price" min="0" step="any" value="${it.price}"></div>
      <div class="field"><label>Qty</label><input type="number" inputmode="decimal" data-k="quantity" min="0" step="any" value="${it.quantity}"></div>
      <div class="field"><label>Disc %</label><input type="number" inputmode="decimal" data-k="discount_percent" min="0" max="100" step="any" value="${it.discount_percent || 0}"></div>
      <div class="field gstonly"><label>GST %</label><input type="number" inputmode="decimal" data-k="tax" min="0" step="any" value="${it.tax}"></div>
      <button type="button" class="btn sm danger" data-rm="${i}" aria-label="Remove line" ${st.items.length < 2 ? 'disabled' : ''}>${ic('x', 15)}</button></div>`).join('');
    $$('.item', el).forEach((row) => {
      const i = +row.dataset.i;
      $$('[data-k]', row).forEach((inp) => (inp.oninput = inp.onchange = () => {
        const k = inp.dataset.k;
        if (k === 'pid') {
          if (inp.value === '__new') {
            return crudForm(CFG.products, null, (p) => {
              products.push(p); Object.assign(st.items[i], { service_product_id: p.id, description: p.description || p.name, sac_number: p.sac_number, price: p.price, tax: p.tax }); drawItems();
            }, () => drawItems());
          }
          const p = products.find((x) => x.id === +inp.value);
          st.items[i].service_product_id = p ? p.id : null;
          if (p) Object.assign(st.items[i], { description: p.description || p.name, sac_number: p.sac_number, price: p.price, tax: p.tax });
          drawItems();
        } else { st.items[i][k] = inp.value; totals(); }
      }));
    });
    $$('[data-rm]', el).forEach((b) => (b.onclick = () => { st.items.splice(+b.dataset.rm, 1); drawItems(); }));
    totals();
  };
  function totals() {
    const same = intra();
    let g = 0, d = 0, s = 0, tax = 0;
    for (const it of st.items) {
      const gross = r2((+it.price || 0) * (+it.quantity || 0)), disc = r2((gross * (+it.discount_percent || 0)) / 100);
      g += gross; d += disc; s += gross - disc; tax += st.gst ? r2(((gross - disc) * (+it.tax || 0)) / 100) : 0;
    }
    const tdsAmt = r2((s * (+$('#tds').value || 0)) / 100), total = r2(s + tax);
    $('#tx').textContent = !st.gst ? 'Without GST — no tax is added.' : client() ? (same ? 'Same state → CGST + SGST applied.' : 'Different state → IGST applied.') : 'Select a client to determine GST type.';
    $('#tt').innerHTML = `<div class="list-line"><span>Gross</span><span>${money(g)}</span></div>
      ${d ? `<div class="list-line"><span>Discount</span><span>− ${money(d)}</span></div>` : ''}
      ${st.gst ? `<div class="list-line"><span>Taxable value</span><span>${money(s)}</span></div>` : ''}
      ${!st.gst ? '' : same ? `<div class="list-line"><span>CGST</span><span>${money(tax / 2)}</span></div><div class="list-line"><span>SGST</span><span>${money(tax / 2)}</span></div>` : `<div class="list-line"><span>IGST</span><span>${money(tax)}</span></div>`}
      <div class="list-line grand"><span>Total</span><span>${money(total)}</span></div>
      ${tdsAmt ? `<div class="list-line"><span>TDS</span><span>− ${money(tdsAmt)}</span></div><div class="list-line grand"><span>Net receivable</span><span>${money(total - tdsAmt)}</span></div>` : ''}`;
    $('#sbt').textContent = money(total - tdsAmt);
  }
  function refresh() { partybox(); totals(); }
  const orgOf = () => orgs.find((o) => o.id === +$('#org').value) || orgs[0];
  const availPay = () => { const o = orgOf(); return { qr: !!(o.qr_image || o.upi_id), upi: !!o.upi_id, bank: !!o.bank_details }; };
  const drawPay = () => {
    const o = orgOf(), av = availPay();
    $('#po').innerHTML = [['qr', 'QR code', av.qr ? (o.qr_image ? 'Your uploaded QR image' : 'Generated from your UPI ID, with the amount filled in') : 'Add a UPI ID or QR image in Settings'],
      ['upi', 'UPI ID', av.upi ? esc(o.upi_id) : 'Add a UPI ID in Settings'], ['bank', 'Bank transfer', av.bank ? 'Account details from your company profile' : 'Add bank details in Settings']]
      .map(([k, l, h]) => `<label class="payopt ${av[k] ? '' : 'off'}"><input type="checkbox" data-p="${k}" ${av[k] && st.pay[k] ? 'checked' : ''} ${av[k] ? '' : 'disabled'}><span><b>${l}</b><small>${h}</small></span></label>`).join('');
    $$('[data-p]', el).forEach((c) => (c.onchange = () => (st.pay[c.dataset.p] = c.checked)));
  };
  const setGst = (on) => { st.gst = on; $$('[data-g]', el).forEach((b) => b.classList.toggle('on', (b.dataset.g === '1') === on)); $('#its').classList.toggle('nogst', !on); totals(); };
  $$('[data-g]', el).forEach((b) => (b.onclick = () => setGst(b.dataset.g === '1')));
  $('#org').oninput = () => { refresh(); drawPay(); }; $('#tds').oninput = totals;
  drawPay();
  $('#ai').onclick = () => { st.items.push({ quantity: 1, price: 0, tax: 18, discount_percent: 0, description: '' }); drawItems(); };
  drawItems(); partybox(); setGst(st.gst);
  const submit = guard(async (e) => {
    e.preventDefault();
    const body = {
      invoice_type: st.type, organisation_id: +$('#org').value, client_id: st.clientId,
      invoice_date: $('#dt').value, due_date: $('#du').value, tds_percent: +$('#tds').value || 0, notes: $('#nt').value,
      gst_applied: st.gst, pay_qr: st.pay.qr && availPay().qr, pay_upi: st.pay.upi && availPay().upi, pay_bank: st.pay.bank && availPay().bank,
      items: st.items.map((i) => ({ service_product_id: i.service_product_id, sac_number: i.sac_number, description: i.description, price: +i.price, quantity: +i.quantity, discount_percent: +i.discount_percent || 0, tax: st.gst ? +i.tax || 0 : 0 })),
    };
    if (!body.client_id) { toast('Select a client first', true); return; }
    $('#sv').disabled = $('#sv2').disabled = true;
    try {
      const r = await api(id ? '/invoices/' + id : '/invoices', { method: id ? 'PUT' : 'POST', body });
      toast('Invoice saved'); if (!id) S.justCreated = r.id; location.hash = '#/invoices/' + r.id; refreshBadge();
    } finally { $('#sv') && ($('#sv').disabled = $('#sv2').disabled = false); }
  });
  $('#f').onsubmit = submit;
}

/* ------------------------------------------------------------ invoice view / print */
function invMobile(v) {
  const isTax = v.invoice_type === 'tax', gst = v.gst_applied !== false;
  const kv = (l, val, cls = '') => `<div class="mi-kv ${cls}"><span>${l}</span><span>${val}</span></div>`;
  return `<div class="mob-only mobinv">
    <div class="card"><div class="row sp"><span class="small muted">${isTax ? 'Tax invoice' : 'Proforma invoice'} · ${esc(v.invoice_number)}</span><span class="small muted">${dmy(v.invoice_date)}</span></div>
      <div class="mi-client">${esc(v.client_name)}</div>${isTax ? '' : `<div class="mi-amt">${money(v.net_amount)}</div>`}${v.due_date ? `<div class="small muted">Due ${dmy(v.due_date)}</div>` : ''}</div>
    <div class="card"><div class="sec-h">Items</div>${v.items.map((i) => `<div class="mi-item"><div><div class="d">${esc(i.description || 'Item')}</div><div class="q">${i.quantity} × ${money(i.price)}${i.discount_amount ? ` · disc ${money(i.discount_amount)}` : ''}${gst ? ` · GST ${Number(i.tax)}%` : ''}</div></div><b>${money(i.selling_amount)}</b></div>`).join('')}</div>
    <div class="card"><div class="sec-h">Summary</div>${kv(gst ? 'Taxable amount' : 'Amount', money(v.selling_amount))}${!gst ? '' : v.intra ? kv('CGST', money(v.cgst)) + kv('SGST', money(v.sgst)) : kv('IGST', money(v.igst))}
      ${v.tds_amount ? kv(`TDS (${v.tds_percent}%)`, '− ' + money(v.tds_amount)) : ''}${kv('Total', money(v.net_amount), 'g')}${v.credit_amount ? kv('Credit notes', '− ' + money(v.credit_amount)) : ''}</div>
    <div class="card"><div class="sec-h">Parties</div><div class="mi-party"><b>${esc(v.org_name)}</b><div class="muted">${esc(String(v.org_address || '').replace(/<[^>]+>/g, ' '))}</div>${v.org_gst && gst ? `<div class="muted">GSTIN ${esc(v.org_gst)}</div>` : ''}</div>
      <div class="mi-party"><b>${esc(v.client_name)}</b><div class="muted">${esc(v.client_address || '')}</div>${v.client_gst && gst ? `<div class="muted">GSTIN ${esc(v.client_gst)}</div>` : ''}</div></div>
    ${v.upi_qr || v.show_upi ? `<div class="card row" style="gap:14px">${v.upi_qr ? `<div style="width:92px;height:92px;flex:none">${v.upi_qr}</div>` : ''}<div><b>${v.upi_qr ? 'Scan &amp; pay' : 'Pay by UPI'}</b>${v.show_upi ? `<div class="small muted">UPI ID: ${esc(v.org_upi)}</div>` : ''}</div></div>` : ''}
    ${v.org_bank ? `<div class="card"><div class="sec-h">Bank details</div><div class="mi-party" style="white-space:pre-line">${esc(v.org_bank)}</div></div>` : ''}
    ${v.notes || v.org_terms ? `<div class="card"><div class="sec-h">Notes &amp; terms</div><div class="mi-party" style="white-space:pre-line">${esc([v.notes, v.org_terms].filter(Boolean).join('\n\n'))}</div></div>` : ''}
    <button class="btn" id="tgd" style="width:100%;margin-top:12px">View printable layout</button></div>`;
}
const docBlockHtml = (v) => `${invMobile(v)}<div class="docwrap desk-only">${docHtml(v)}</div>`;
const bindDocToggle = (el) => { const b = $('#tgd', el); if (b) b.onclick = () => { const d = $('.docwrap', el); d.classList.toggle('show'); b.textContent = d.classList.contains('show') ? 'Hide printable layout' : 'View printable layout'; }; };

function docHtml(v) {
  const isTax = v.invoice_type === 'tax', gst = v.gst_applied !== false;
  return `    <div class="doc ${v.invoice_type}"><div class="in">
      <div class="top-h"><div class="logo-box">${v.org_logo ? `<img src="${esc(v.org_logo)}" alt="${esc(v.org_name)}">` : `<div class="nm">${esc((v.org_name || '').toUpperCase())}</div>`}</div>
        <div><div class="ttl">${isTax ? (gst ? 'TAX INVOICE' : 'INVOICE') : 'PROFORMA INVOICE'}</div>
          <div class="meta"><b>Invoice No:</b> ${esc(v.invoice_number)}<br><b>Date:</b> ${dmy(v.invoice_date)}${v.due_date ? `<br><b>Due:</b> ${dmy(v.due_date)}` : ''}
          ${isTax && v.payment_status === 'paid' ? '<br><span class="stamp-paid">PAID</span>' : ''}</div></div></div>
      <div class="two"><div><div class="secbar">Raised From</div><div class="kv"><div><b>${esc(v.org_name)}</b></div>
          ${v.org_address ? `<div><b>Address:</b> ${esc(String(v.org_address).replace(/<[^>]+>/g, ' '))}</div>` : ''}${v.org_contact ? `<div><b>Phone:</b> ${esc(v.org_contact)}</div>` : ''}
          ${v.org_email ? `<div><b>Email:</b> ${esc(v.org_email)}</div>` : ''}${v.org_gst && gst ? `<div><b>GST No:</b> ${esc(v.org_gst)}</div>` : ''}${v.org_pan ? `<div><b>PAN:</b> ${esc(v.org_pan)}</div>` : ''}</div></div>
        <div><div class="secbar">Raised To</div><div class="kv"><div><b>${esc(v.client_name)}</b></div>
          ${v.client_address ? `<div><b>Address:</b> ${esc(v.client_address)}</div>` : ''}${v.client_contact ? `<div><b>Contact Number:</b> ${esc(v.client_contact)}</div>` : ''}
          ${v.client_email ? `<div><b>Email:</b> ${esc(v.client_email)}</div>` : ''}${gst ? `<div><b>GST Number:</b> ${esc(v.client_gst || 'N/A')}</div>` : ''}
          ${gst && v.place_of_supply ? `<div><b>Place of supply:</b> ${esc(v.place_of_supply)}</div>` : ''}</div></div></div>
      <div class="tablewrap"><table class="it"><thead><tr><th>#</th><th>Service / Product</th><th>Description</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Discount</th>${gst ? '<th class="num">Tax</th>' : ''}<th class="num">Amount</th></tr></thead><tbody>
      ${v.items.map((i) => `<tr><td>${i.position}</td><td>${esc(i.sac_number ? 'SAC ' + i.sac_number : '')}</td><td>${esc(i.description)}</td><td class="num">${money(i.price)}</td><td class="num">${i.quantity}</td><td class="num">${i.discount_amount ? money(i.discount_amount) : '—'}</td>${gst ? `<td class="num">${Number(i.tax).toFixed(2)}%</td>` : ''}<td class="num">${money(i.selling_amount)}</td></tr>`).join('')}</tbody></table></div>
      <div class="lower"><div class="bank">${v.org_bank ? `<div class="cap">Payment to be deposited favouring <b>“${esc(v.org_name)}”</b></div><pre>${esc(v.org_bank)}</pre>` : ''}
        ${v.upi_qr ? `<div class="upi"><div class="qr">${v.upi_qr}</div><div><b>Scan &amp; pay ${money(v.invoice_type === 'tax' ? v.balance_amount : v.net_amount)}</b>${v.show_upi ? `<div class="small">UPI: ${esc(v.org_upi)}</div>` : ''}<div class="small muted">GPay · PhonePe · Paytm · any UPI app</div></div></div>` : v.show_upi ? `<div class="upi"><div><b>Pay via UPI</b><div class="small">UPI ID: ${esc(v.org_upi)}</div></div></div>` : ''}</div>
        <div class="sum"><div class="l"><span>${gst ? 'Taxable Amount' : 'Amount'}</span><b>${money(v.selling_amount)}</b></div>
          ${!gst ? '' : v.intra ? `<div class="l"><span>CGST</span><b>${money(v.cgst)}</b></div><div class="l"><span>SGST</span><b>${money(v.sgst)}</b></div>` : `<div class="l"><span>IGST</span><b>${money(v.igst)}</b></div>`}
          ${v.tds_amount ? `<div class="l"><span>TDS (${v.tds_percent}%)</span><b>− ${money(v.tds_amount)}</b></div>` : ''}
          <div class="l g"><span>Total Amount</span><span>${money(v.net_amount)}</span></div>
          ${isTax && (v.paid_amount || v.credit_amount) ? `${v.credit_amount ? `<div class="l"><span>Less: Credit notes</span><b>− ${money(v.credit_amount)}</b></div>` : ''}${v.paid_amount ? `<div class="l"><span>Paid</span><b>${money(v.paid_amount)}</b></div>` : ''}<div class="l"><span>Balance Due</span><b>${money(Math.max(0, v.balance_amount))}</b></div>` : ''}</div></div>
      ${v.notes ? `<div class="notes"><b>Notes:</b> ${esc(v.notes)}</div>` : ''}
      ${v.org_terms ? `<div class="notes"><b>Terms &amp; Conditions</b><pre>${esc(v.org_terms)}</pre></div>` : ''}
      <div class="sign"><div>${v.org_signature ? `<img src="${esc(v.org_signature)}" alt="Signature">` : '<div style="height:50px"></div>'}<div class="ln">Authorized Signature</div></div></div>
    </div><div class="thanks">${esc(v.org_footer || 'Thank you for your generous support!')}</div></div>`;
}

/* ------------------------------------------------------------ invoice page (v4) */
function createdSheet(v) {
  const m = modal(`<div class="done-h"><span class="done-ic">${ic('check', 26)}</span><h2>Invoice created</h2><div class="muted">${esc(v.invoice_number)} · ${money(v.net_amount)}</div></div>
    <div class="next-grid">${can('reminders.send') ? `<button class="next" id="n-wa"><span class="wa-c">${ic('chat', 20)}</span>Send on WhatsApp</button><button class="next" id="n-em"><span>${ic('mail', 20)}</span>Send by email</button>` : ''}
      <button class="next" id="n-img"><span>${ic('copy', 20)}</span>Copy invoice image</button><button class="next" id="n-sh"><span>${ic('link', 20)}</span>Copy share link</button>${v.invoice_type === 'tax' && can('payments.create') ? `<button class="next" id="n-pay"><span>${ic('rupee', 20)}</span>Already paid? Record</button>` : ''}
      ${can('invoices.create') ? `<a class="next" href="#/invoices/new?type=${v.invoice_type}" id="n-new"><span>${ic('plus', 20)}</span>Create another</a>` : ''}</div>
    <div class="actions"><button class="btn" data-x>Done</button></div>`);
  const on = (id, fn) => { const b = $(id, m.el); if (b) b.onclick = () => { m.close(); fn && fn(); }; };
  $('[data-x]', m.el).onclick = m.close;
  on('#n-wa', () => openMessage({ client_id: v.client_id, invoice_id: v.id, channel: 'whatsapp', kind: 'invoice' }));
  on('#n-em', () => openMessage({ client_id: v.client_id, invoice_id: v.id, channel: 'email', kind: 'invoice' }));
  on('#n-sh', () => shareModal(v, () => {}));
  on('#n-img', () => copyInvoiceImage(v));
  on('#n-pay', () => quickPay(v, () => route()));
  on('#n-new');
}

/* ------------------------------------------------------------ invoice as an image (paste / share on WhatsApp) */
let h2cLoad;
const loadH2C = () => (h2cLoad ||= new Promise((res, rej) => {
  if (window.html2canvas) return res();
  const sc = document.createElement('script');
  sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  sc.onload = res; sc.onerror = () => { h2cLoad = null; rej(new Error('Could not load the image tool — check your internet connection')); };
  document.head.append(sc);
}));
async function invoiceBlob(v) {
  await loadH2C();
  const host = document.createElement('div');
  host.className = 'capture';
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;background:#fff';
  host.innerHTML = docHtml(v);
  document.body.append(host);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const canvas = await window.html2canvas(host.firstElementChild, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    return await new Promise((r) => canvas.toBlob(r, 'image/png'));
  } finally { host.remove(); }
}
const imgName = (v) => v.invoice_number.split('/').join('-') + '.png';
function downloadBlob(blob, name) { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); }
async function copyInvoiceImage(src) { // src: invoice object, or a promise of one
  const vp = Promise.resolve(src);
  toast('Preparing invoice image…');
  try {
    const canClip = navigator.clipboard && window.ClipboardItem && !mobile();
    if (canClip) {
      // hand the promise to the clipboard so the click gesture stays valid while the image renders
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': vp.then(invoiceBlob) })]);
      toast('Image copied — paste it in WhatsApp (Ctrl+V)');
      return;
    }
    const v = await vp, blob = await invoiceBlob(v), file = new File([blob], imgName(v), { type: 'image/png' }), url = URL.createObjectURL(blob);
    const m = modal(`<h2>Invoice image</h2><img src="${url}" alt="Invoice" style="width:100%;border:1px solid var(--line);border-radius:12px;max-height:52vh;object-fit:contain;background:#fff">
      <div class="actions"><button class="btn" id="im-dl">${ic('download')} Save</button>${navigator.clipboard && window.ClipboardItem ? `<button class="btn" id="im-cp">${ic('copy')} Copy</button>` : ''}${navigator.canShare && navigator.canShare({ files: [file] }) ? `<button class="btn wa" id="im-sh">${ic('share')} Share</button>` : ''}</div>`);
    $('#im-dl', m.el).onclick = () => downloadBlob(blob, imgName(v));
    if ($('#im-cp', m.el)) $('#im-cp', m.el).onclick = guard(async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Image copied'); });
    if ($('#im-sh', m.el)) $('#im-sh', m.el).onclick = guard(async () => { try { await navigator.share({ files: [file], title: v.invoice_number }); } catch (e) { if (e.name !== 'AbortError') throw e; } });
  } catch (e) {
    if (e.name === 'NotAllowedError') toast('Browser blocked copying — use Save instead', true); else toast(e.message || 'Could not create image', true);
  }
}

async function viewInvoice(el, id) {
  const v = await api('/invoices/' + id);
  const isTax = v.invoice_type === 'tax';
  const pending = Math.max(0, v.balance_amount), late = isTax && pending > 0.005 ? daysLate(v.due_date) : 0;
  const payable = r2(v.net_amount - (v.credit_amount || 0)), pct = payable > 0 ? (v.paid_amount / payable) * 100 : 100;
  const statusLbl = !isTax ? 'Proforma' : v.payment_status === 'paid' ? 'Paid' : late > 0 ? 'Overdue' : v.payment_status === 'partial' ? 'Partially paid' : 'Unpaid';
  const statusCls = !isTax ? 'proforma' : v.payment_status === 'paid' ? 'ok' : late > 0 ? 'bad' : v.payment_status === 'partial' ? 'warn' : 'mut';
  // ledger: issued → credit notes / payments in date order, with the balance left after each step
  const events = [{ d: v.invoice_date, k: 'issued' }, ...v.payments.map((p) => ({ d: p.paid_on, k: 'pay', p })), ...(v.credit_notes || []).map((c) => ({ d: c.note_date, k: 'cn', c }))]
    .sort((a, b) => a.d.localeCompare(b.d) || (a.k === 'issued' ? -1 : 1));
  let bal = v.net_amount;
  const tl = events.map((e) => {
    if (e.k === 'issued') return `<div class="tl-i"><span class="tl-dot"></span><div class="tl-b"><div class="row sp"><b>Invoice issued</b><span class="small muted">${fmtLong(e.d)}</span></div><div class="small muted">Payable ${money(v.net_amount)}${v.tds_amount ? ` (after TDS ${money(v.tds_amount)})` : ''}</div></div></div>`;
    if (e.k === 'cn') { bal -= e.c.total; return `<div class="tl-i"><span class="tl-dot warn"></span><div class="tl-b"><div class="row sp"><b class="warnc">− ${money(e.c.total)}</b><span class="small muted">${fmtLong(e.d)}</span></div><div class="small muted"><a href="#/credit-notes/${e.c.id}">${esc(e.c.number)}</a>${e.c.reason ? ' · ' + esc(e.c.reason) : ''} · balance ${money(Math.max(0, bal))}</div></div></div>`; }
    bal -= e.p.amount;
    return `<div class="tl-i"><span class="tl-dot ok"></span><div class="tl-b"><div class="row sp"><b class="pos">+ ${money(e.p.amount)}</b><span class="small muted">${fmtLong(e.d)}</span></div>
      <div class="small muted">${[e.p.mode, e.p.reference, e.p.by_name && 'by ' + e.p.by_name].filter(Boolean).map(esc).join(' · ') || 'Payment received'} · balance ${money(Math.max(0, bal))}</div>
      <div class="tl-a">${can('reminders.send') ? `<button class="mini" data-rc="${e.p.id}">Send receipt</button>` : ''}${can('payments.delete') ? `<button class="mini bad" data-dp="${e.p.id}">Delete</button>` : ''}</div></div></div>`;
  }).join('');
  const acts = [
    { i: 'printer', l: 'Download / print PDF', id: 'a-pdf' },
    { i: 'copy', l: 'Copy invoice as image', id: 'a-img' },
    can('reminders.send') && { i: 'mail', l: 'Send by email', id: 'a-em' },
    { i: 'link', l: 'Share link with client', id: 'a-sh' },
    isTax && can('recurring.create') && { i: 'repeat', l: 'Make recurring', id: 'a-rc' },
    isTax && can('invoices.create') && v.net_amount - v.credit_amount > 0.005 && { i: 'file', l: 'Issue credit note', id: 'a-cn' },
    can('invoices.edit') && { i: 'edit', l: 'Edit invoice', id: 'a-ed' },
    can('invoices.delete') && { i: 'trash', l: 'Delete invoice', id: 'a-dl', cls: 'bad' },
  ].filter(Boolean);
  el.innerHTML = `<div class="pagehead noprint inv-head"><div><a href="#/invoices" class="small back">${ic('back', 14)} Invoices</a>
      <h1 class="keep">${esc(v.invoice_number)} <span class="st-pill ${statusCls}">${statusLbl}${late > 0 && v.payment_status !== 'paid' ? ` · ${late}d` : ''}</span></h1>
      <div class="muted small">${esc(v.client_name)} · issued ${fmtLong(v.invoice_date)}${v.due_date ? ` · due ${fmtLong(v.due_date)}` : ''}</div></div>
      <div class="row acts">${isTax && can('payments.create') && pending > 0.005 ? `<button class="btn primary" id="ap">${ic('rupee')} Record payment</button>` : ''}
        ${!isTax && !v.converted_to_id && can('invoices.create') ? '<button class="btn primary" id="cv">Convert to tax invoice</button>' : ''}
        ${can('reminders.send') ? `<button class="btn wa" id="wa">${ic('chat')} Send</button>` : ''}
        <button class="btn" id="cp" title="Copy invoice as an image to paste in WhatsApp">${ic('copy')} ${mobile() ? 'Image' : 'Copy image'}</button>
        ${v.converted_to_id ? `<a class="btn" href="#/invoices/${v.converted_to_id}">View tax invoice →</a>` : ''}${v.converted_from_id ? `<a class="btn" href="#/invoices/${v.converted_from_id}">← Source proforma</a>` : ''}
        <button class="btn" id="mo">${ic('more')} More</button></div></div>
    ${isTax ? `<section class="card payhero noprint"><div class="ph-top"><div class="ph-ring">${ring(pct, 128, 13, statusCls === 'bad' ? 'var(--bad)' : 'var(--ok)')}<div class="small muted" style="text-align:center;margin-top:6px">received</div></div>
        <div class="ph-stats"><div class="ph-row"><span>Invoice amount</span><b>${money(v.net_amount)}</b></div>${v.credit_amount ? `<div class="ph-row"><span>Credit notes</span><b>− ${money(v.credit_amount)}</b></div>` : ''}
          <div class="ph-row ok"><span>Received</span><b>${money(v.paid_amount)}</b></div><div class="ph-row big ${pending > 0.005 ? 'bad' : 'ok'}"><span>${pending > 0.005 ? 'Pending' : 'Balance'}</span><b>${money(pending)}</b></div>
          <div class="ph-note ${statusCls}">${v.payment_status === 'paid' ? 'Fully paid — nothing pending.' : late > 0 ? `${late} day${late === 1 ? '' : 's'} overdue — follow up for ${money(pending)}.` : v.due_date ? `Due ${-daysLate(v.due_date) <= 0 ? 'today' : 'in ' + -daysLate(v.due_date) + ' days'} (${fmtLong(v.due_date)}).` : 'No due date set.'}${v.view_count ? ` Client viewed the link ${v.view_count}×.` : v.share_token ? ' Link shared, not opened yet.' : ''}</div></div></div>
        <div class="prog"><span style="width:${Math.min(100, pct)}%"></span></div>
        <div class="row sp" style="margin:18px 0 8px"><h3>Payment history</h3>${isTax && can('payments.create') && pending > 0.005 ? '<button class="mini solid" id="ap2">+ Add payment</button>' : ''}</div>
        <div class="tl">${tl}</div>${v.payments.length ? '' : '<div class="tl-empty">No payment received yet.</div>'}</section>` : `<section class="card noprint hint-card"><b>Proforma invoice</b><div class="muted small">Payments are tracked on the tax invoice. Convert this proforma when the client confirms.</div></section>`}
    ${docBlockHtml(v)}`;

  bindDocToggle(el);
  const refresh = () => viewInvoice(el, id);
  const send = (channel) => openMessage({ client_id: v.client_id, invoice_id: v.id, channel, kind: pending > 0.005 && late > 0 ? undefined : 'invoice' });
  const doPay = () => quickPay(v, refresh);
  const doDelete = guard(async () => { if (!(await confirmBox('Delete this invoice and its payments? This cannot be undone.'))) return; await api('/invoices/' + id, { method: 'DELETE' }); toast('Deleted'); location.hash = '#/invoices'; refreshBadge(); });
  const table = {
    'a-pdf': () => window.print(), 'a-img': () => copyInvoiceImage(v), 'a-em': () => send('email'), 'a-sh': guard(() => shareModal(v, refresh)),
    'a-rc': () => recurringModal({ invoice_id: v.id, invoice_date: v.invoice_date, due_days: v.due_date ? Math.max(0, Math.round((Date.parse(v.due_date) - Date.parse(v.invoice_date)) / 864e5)) : 7 }, () => (location.hash = '#/recurring')),
    'a-cn': () => creditModal(v, refresh), 'a-ed': () => (location.hash = `#/invoices/${id}/edit`), 'a-dl': doDelete,
  };
  $('#mo').onclick = () => {
    const m = modal(`<h2>${esc(v.invoice_number)}</h2><div class="menu-list">${acts.map((a) => `<button class="menu-i ${a.cls || ''}" data-a="${a.id}"><span>${ic(a.i, 19)}</span>${a.l}<i>${ic('chevron', 16)}</i></button>`).join('')}</div>`);
    $$('[data-a]', m.el).forEach((b) => (b.onclick = () => { m.close(); table[b.dataset.a](); }));
  };
  if ($('#ap')) $('#ap').onclick = doPay;
  if ($('#ap2')) $('#ap2').onclick = doPay;
  if ($('#wa')) $('#wa').onclick = () => send('whatsapp');
  $('#cp').onclick = () => copyInvoiceImage(v);
  if ($('#cv')) $('#cv').onclick = guard(async () => { if (!(await confirmBox('Create a tax invoice from this proforma?'))) return; const r = await api(`/invoices/${id}/convert`, { method: 'POST' }); toast('Tax invoice created'); S.justCreated = r.id; location.hash = '#/invoices/' + r.id; });
  $$('[data-rc]', el).forEach((b) => (b.onclick = () => openMessage({ client_id: v.client_id, invoice_id: v.id, payment_id: +b.dataset.rc, kind: 'receipt' })));
  $$('[data-dp]', el).forEach((b) => (b.onclick = guard(async () => { if (!(await confirmBox('Delete this payment?'))) return; await api('/payments/' + b.dataset.dp, { method: 'DELETE' }); refreshBadge(); refresh(); })));
  if (S.justCreated === v.id) { S.justCreated = null; setTimeout(() => createdSheet(v), 250); }
}

/* ------------------------------------------------------------ GSTIN helper: format + checksum, state, PAN */
function gstInfo(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!g) return { empty: true };
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return { ok: false, msg: g.length < 15 ? `${g.length}/15 characters` : 'Not a valid GSTIN format' };
  const set = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = set.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  const okSum = set[(36 - (sum % 36)) % 36] === g[14];
  const code = g.slice(0, 2);
  if (!S.meta.states[code]) return { ok: false, msg: 'Unknown state code ' + code };
  return { ok: okSum, msg: okSum ? '' : 'Checksum does not match — please re-check the number', code, state: S.meta.states[code], pan: g.slice(2, 12) };
}
function gstHelper(form) {
  const inp = form.elements['gst_number'];
  if (!inp) return;
  const field = inp.closest('.field'), hint = document.createElement('div');
  hint.className = 'small gst-hint'; field.append(hint);
  const st = form.elements['state_code'], pan = form.elements['pan_number'];
  let lastPan = pan ? pan.value : '';
  const run = () => {
    inp.value = inp.value.toUpperCase();
    const i = gstInfo(inp.value);
    hint.className = 'small gst-hint';
    if (i.empty) { hint.textContent = ''; return; }
    if (!i.code) { hint.classList.add('bad'); hint.textContent = i.msg; return; }
    hint.classList.add(i.ok ? 'pos' : 'warnc');
    hint.textContent = i.ok ? `Valid GSTIN · ${i.state} · PAN ${i.pan}` : `${i.msg} · ${i.state}`;
    if (st) st.value = i.code;
    if (pan && (!pan.value || pan.value === lastPan)) { pan.value = i.pan; lastPan = i.pan; }
  };
  inp.addEventListener('input', run); run();
  // icon button beside the GSTIN box: fills everything that can be worked out from the number
  const row = document.createElement('div');
  row.className = 'inline-add';
  inp.before(row); row.append(inp);
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'ibtn gst-fetch'; b.title = 'Fetch details from GST number'; b.setAttribute('aria-label', 'Fetch details from GST number'); b.innerHTML = ic('search', 18);
  row.append(b);
  b.onclick = guard(async () => {
    const i = gstInfo(inp.value);
    if (!i.code) return toast('Enter a valid 15-character GSTIN first', true);
    run();
    if (!S.meta.gst_lookup) return toast('State and PAN filled. Name & address need a GST API key on the server.');
    b.disabled = true; b.innerHTML = '…';
    try {
      const d = await api('/gst-lookup/' + encodeURIComponent(inp.value.trim().toUpperCase()));
      const set = (n, v) => { const el = form.elements[n]; if (el && v && !el.value) el.value = v; };
      set('name', d.name); set('address', d.address);
      toast(d.status ? `Details filled · GST status: ${d.status}` : 'Details filled — please verify');
    } finally { b.disabled = false; b.innerHTML = ic('search', 18); }
  });
}

/* ------------------------------------------------------------ generic CRUD */
const STATE_OPTS = () => Object.entries(S.meta.states).map(([c, n]) => ({ v: c, l: `${n} (${c})` }));
const CFG = {
  clients: {
    title: 'Clients', api: '/clients', perm: 'clients', noun: 'client', onOpen: gstHelper,
    cols: [{ k: 'name', l: 'Name', first: true }, { k: 'contact_person', l: 'Contact' }, { k: 'mobile', l: 'Mobile' }, { k: 'email', l: 'Email' }, { k: 'gst_number', l: 'GSTIN' },
      { k: 'status', l: 'Status', raw: 1, f: (v) => ({ inactive: '<span class="pill unpaid">Inactive</span>', on_hold: '<span class="pill partial">On hold</span>' }[v] || '<span class="pill paid">Active</span>') }],
    fields: [
      { k: 'name', l: 'Company name', req: 1, full: 1 }, { k: 'contact_person', l: 'Contact person' }, { k: 'mobile', l: 'Mobile (WhatsApp)', ph: '9876543210' },
      { k: 'email', l: 'Email', t: 'email' }, { k: 'gst_number', l: 'GSTIN', ph: '06AAAAA0000A1Z5' }, { k: 'pan_number', l: 'PAN' },
      { k: 'address', l: 'Address', t: 'textarea', full: 1 }, { k: 'state_code', l: 'State (auto from GSTIN)', t: 'select', opts: STATE_OPTS, blank: 1, full: 1 },
      { k: 'status', l: 'Status', t: 'select', opts: [{ v: 'active', l: 'Active' }, { v: 'inactive', l: 'Inactive' }, { v: 'on_hold', l: 'On hold' }] },
    ],
    defaults: { status: 'active' },
  },
  products: {
    title: 'Services & products', api: '/products', perm: 'products', noun: 'service',
    cols: [{ k: 'name', l: 'Name', first: true }, { k: 'sac_number', l: 'SAC' }, { k: 'price', l: 'Price', f: money, num: 1 }, { k: 'tax', l: 'GST %', f: (v) => v + '%', num: 1 }],
    fields: [{ k: 'name', l: 'Name', req: 1, full: 1 }, { k: 'sac_number', l: 'SAC / HSN' }, { k: 'price', l: 'Price', t: 'number' }, { k: 'tax', l: 'GST %', t: 'number' }, { k: 'description', l: 'Default description', t: 'textarea', full: 1 }],
    defaults: { tax: 18, price: 0 },
  },
  templates: {
    title: 'Message templates', api: '/templates', perm: 'templates', noun: 'template',
    help: 'Templates power the WhatsApp / Email buttons. Templates using invoice placeholders (invoice_number, due_date…) appear only when sending for a single invoice.',
    cols: [{ k: 'name', l: 'Name', first: true }, { k: 'channel', l: 'Channel', f: (v) => (v === 'email' ? 'Email' : 'WhatsApp') }, { k: 'kind', l: 'Used for', f: (v) => ({ invoice: 'Sending invoice', receipt: 'Payment receipt' }[v] || 'Payment reminder') }],
    fields: [
      { k: 'name', l: 'Template name', req: 1, full: 1 },
      { k: 'channel', l: 'Channel', t: 'select', opts: [{ v: 'whatsapp', l: 'WhatsApp' }, { v: 'email', l: 'Email' }] },
      { k: 'kind', l: 'Used for', t: 'select', opts: [{ v: 'reminder', l: 'Payment reminder' }, { v: 'invoice', l: 'Sending invoice' }, { v: 'receipt', l: 'Payment receipt' }] },
      { k: 'subject', l: 'Email subject (email only)', full: 1 }, { k: 'body', l: 'Message', t: 'textarea', rows: 9, req: 1, full: 1 },
    ],
    defaults: { channel: 'whatsapp', kind: 'reminder' },
    onOpen(form) {
      const vars = ['client_name', 'contact_person', 'pending_count', 'total_pending', 'overdue_count', 'invoice_list', 'invoice_number', 'invoice_date', 'due_date', 'invoice_total', 'invoice_balance', 'days_overdue', 'invoice_link', 'payment_amount', 'payment_date', 'payment_mode', 'upi_link', 'upi_id', 'org_name', 'org_contact'];
      const box = document.createElement('div'); box.className = 'full';
      box.innerHTML = `<div class="small muted" style="margin-bottom:6px">Tap to insert a placeholder:</div><div class="chips">${vars.map((v) => `<span class="chip" data-v="${v}">{{${v}}}</span>`).join('')}</div>`;
      $('[name=body]', form).closest('.field').after(box);
      let last = $('[name=body]', form);
      form.addEventListener('focusin', (e) => { if (e.target.matches('[name=body],[name=subject]')) last = e.target; });
      box.onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; const t = `{{${c.dataset.v}}}`, s = last.selectionStart ?? last.value.length; last.value = last.value.slice(0, s) + t + last.value.slice(last.selectionEnd ?? s); last.focus(); last.setSelectionRange(s + t.length, s + t.length); };
    },
  },
  expenses: {
    title: 'Expenses', api: '/expenses', perm: 'expenses', noun: 'expense', help: 'Record what you spend so the dashboard can show your net position.',
    cols: [{ k: 'date', l: 'Date', first: true, f: dmy }, { k: 'category', l: 'Category' }, { k: 'vendor', l: 'Vendor' }, { k: 'amount', l: 'Amount', f: money, num: 1 }, { k: 'notes', l: 'Notes' }],
    fields: [{ k: 'date', l: 'Date', t: 'date', req: 1 }, { k: 'amount', l: 'Amount', t: 'number', req: 1 },
      { k: 'category', l: 'Category', t: 'select', opts: ['Salary', 'Rent', 'Software & tools', 'Marketing', 'Travel', 'Office', 'Taxes & fees', 'Other'].map((c) => ({ v: c, l: c })) },
      { k: 'vendor', l: 'Paid to' }, { k: 'notes', l: 'Notes', full: 1 }],
    get defaults() { return { date: todayStr(), category: 'Other' }; },
    mTitle: (r) => r.vendor || r.category,
  },
  users: {
    title: 'Users', api: '/users', perm: 'users', noun: 'user',
    cols: [{ k: 'name', l: 'Name', first: true }, { k: 'email', l: 'Email' }, { k: 'role', l: 'User type' }, { k: 'active', l: 'Status', f: (v) => (v ? '<span class="pill paid">Active</span>' : '<span class="pill unpaid">Disabled</span>'), raw: 1 }],
    fields: [
      { k: 'name', l: 'Name', req: 1 }, { k: 'email', l: 'Email', t: 'email', req: 1 },
      { k: 'password', l: 'Password (min 6)', t: 'password', reqNew: 1, ph: 'leave blank to keep', noFill: 1 },
      { k: 'role_id', l: 'User type', t: 'select', opts: async () => (await api('/roles')).map((r) => ({ v: r.id, l: r.name })), req: 1 },
      { k: 'active', l: 'Active', t: 'checkbox' },
    ],
    defaults: { active: 1 },
  },
  organisations: {
    title: 'Billing entities', api: '/organisations', perm: 'settings', write: 'edit', noun: 'billing entity', small: 1, onOpen: gstHelper,
    cols: [{ k: 'name', l: 'Name', first: true }, { k: 'gst_number', l: 'GSTIN' }, { k: 'contact', l: 'Contact' }],
    fields: [{ k: 'name', l: 'Name', req: 1, full: 1 }, { k: 'gst_number', l: 'GSTIN' }, { k: 'pan_number', l: 'PAN' }, { k: 'email', l: 'Email', t: 'email' }, { k: 'contact', l: 'Phone' },
      { k: 'address', l: 'Address', t: 'textarea', full: 1 }, { k: 'bank_details', l: 'Bank details (printed on invoice)', t: 'textarea', rows: 5, full: 1 },
      { k: 'upi_id', l: 'UPI ID (adds a "scan & pay" QR to invoices)', ph: 'yourname@bank', full: 1 },
      { k: 'qr_image', l: 'Your own payment QR image (optional — otherwise a UPI QR is generated)', t: 'image', full: 1 },
      { k: 'terms', l: 'Terms & conditions (printed on every invoice)', t: 'textarea', rows: 5, full: 1 },
      { k: 'logo', l: 'Logo (shown on invoice)', t: 'image', full: 1 }, { k: 'signature', l: 'Signature image', t: 'image', full: 1 },
      { k: 'footer_note', l: 'Footer line', ph: 'Thank you for your generous support!', full: 1 }],
    after: async () => { S.meta.organisations = await api('/organisations'); },
  },
  ccEmails: {
    title: 'CC emails (added to every email)', api: '/cc-emails', perm: 'settings', write: 'edit', noun: 'email', small: 1,
    cols: [{ k: 'email', l: 'Email', first: true }], fields: [{ k: 'email', l: 'Email', t: 'email', req: 1, full: 1 }],
  },
};

function crudMobile(el, cfg, rows, key) {
  const reload = () => crudView(el, cfg);
  const numCol = cfg.cols.find((c) => c.num), fmt = (c, r) => (c.f ? c.f(r[c.k]) : r[c.k]);
  const title = (r) => (cfg.mTitle ? cfg.mTitle(r) : fmt(cfg.cols[0], r)) || '—';
  const pg = paginate('crud:' + cfg.api, rows);
  el.innerHTML = `${cfg.small ? `<h2 style="margin:0 0 8px">${cfg.title}</h2>` : ''}${cfg.help ? `<p class="muted small" style="margin:0 0 12px">${cfg.help}</p>` : ''}
    <div class="listhead"><span>${rows.length} ${cfg.noun}${rows.length === 1 ? '' : 's'}</span>${can(key('create')) ? `<button class="btn primary sm" id="add">${ic('plus')} Add</button>` : ''}</div>
    ${rows.length ? `<div class="rows">${pg.rows.map((r) => {
      const t = String(title(r)), subs = cfg.cols.filter((c) => !c.num && !c.raw && r[c.k] && fmt(c, r) !== t && !(c === cfg.cols[0] && !cfg.mTitle)).slice(0, 2).map((c) => fmt(c, r));
      return `<div class="ri" data-e="${r.id}">${avatar(t)}<div class="mid"><div class="t">${esc(t)}</div><div class="s">${subs.map(esc).join(' · ')}</div></div>${numCol ? `<div class="end"><div class="amt">${esc(fmt(numCol, r))}</div></div>` : ''}</div>`;
    }).join('')}</div>${pg.html}` : '<div class="empty card">Nothing here yet.</div>'}`;
  pg.bind(el, reload);
  if ($('#add', el)) $('#add', el).onclick = () => crudForm(cfg, null, reload);
  $$('[data-e]', el).forEach((b) => (b.onclick = () => can(key('edit')) && crudForm(cfg, rows.find((r) => r.id === +b.dataset.e), reload)));
}
async function crudView(el, cfg) {
  const rows = await api(cfg.api);
  const key = (a) => `${cfg.perm}.${cfg.write && a !== 'view' ? cfg.write : a}`;
  if (mobile()) return crudMobile(el, cfg, rows, key);
  const pg = paginate('crud:' + cfg.api, rows);
  el.innerHTML = `<div class="pagehead"><div>${cfg.small ? `<h2>${cfg.title}</h2>` : `<h1>${cfg.title}</h1>`}${cfg.help ? `<div class="muted small">${cfg.help}</div>` : ''}</div>
    ${can(key('create')) ? `<button class="btn primary" id="add">+ Add ${cfg.noun}</button>` : ''}</div>
    ${rows.length ? `<div class="card tablewrap" style="padding:0"><table class="stackable"><thead><tr>${cfg.cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.l}</th>`).join('')}<th></th></tr></thead><tbody>
    ${pg.rows.map((r) => `<tr>${cfg.cols.map((c) => { const v = c.f ? c.f(r[c.k]) : esc(r[c.k] ?? ''); return `<td class="${c.first ? 'first' : ''} ${c.num ? 'num' : ''}" data-label="${c.l}">${v}</td>`; }).join('')}
      <td class="acts nowrap">${can(key('edit')) ? `<button class="btn sm" data-e="${r.id}">Edit</button> ` : ''}${can(key('delete')) ? `<button class="btn sm danger" data-d="${r.id}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>${pg.html}` : `<div class="empty card">Nothing here yet.</div>`}`;
  const reload = () => crudView(el, cfg);
  pg.bind(el, reload);
  if ($('#add', el)) $('#add', el).onclick = () => crudForm(cfg, null, reload);
  $$('[data-e]', el).forEach((b) => (b.onclick = () => crudForm(cfg, rows.find((r) => r.id === +b.dataset.e), reload)));
  $$('[data-d]', el).forEach((b) => (b.onclick = guard(async () => {
    if (!(await confirmBox(`Delete this ${cfg.noun}?`))) return;
    await api(`${cfg.api}/${b.dataset.d}`, { method: 'DELETE' }); toast('Deleted'); cfg.after && (await cfg.after()); reload();
  })));
}
async function crudForm(cfg, row, done, onCancel) {
  const vals = row || cfg.defaults || {};
  const fieldHtml = [];
  for (const f of cfg.fields) {
    const v = f.noFill ? '' : f.val ? f.val(vals) : vals[f.k] ?? '';
    let input;
    if (f.t === 'multi') input = `<input type="hidden" name="${f.k}" value="${esc(JSON.stringify(v || []))}">`;
    else if (f.t === 'textarea') input = `<textarea name="${f.k}" rows="${f.rows || 3}" ${f.req ? 'required' : ''}>${esc(v)}</textarea>`;
    else if (f.t === 'select') {
      const opts = typeof f.opts === 'function' ? await f.opts() : f.opts;
      input = `<select name="${f.k}" ${f.req ? 'required' : ''}>${f.blank ? '<option value="">—</option>' : ''}${opts.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(v) ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`;
    } else if (f.t === 'image') input = `<div class="imgfield" data-img="${f.k}"><img class="${v ? '' : 'hidden'}" src="${esc(v)}" alt=""><input type="file" accept="image/*" style="min-height:0"><input type="hidden" name="${f.k}" value="${esc(v)}"><button type="button" class="btn sm ${v ? '' : 'hidden'}" data-clr>Remove</button></div>`;
    else if (f.t === 'checkbox') input = `<input type="checkbox" name="${f.k}" ${v ? 'checked' : ''}>`;
    else input = `<input name="${f.k}" type="${f.t || 'text'}" ${f.t === 'number' ? 'step="any"' : ''} value="${esc(v)}" placeholder="${esc(f.ph || '')}" ${f.req || (f.reqNew && !row) ? 'required' : ''} ${f.t === 'password' ? 'autocomplete="new-password"' : ''}>`;
    fieldHtml.push(`<div class="field ${f.full ? 'full' : ''}"><label>${f.l}</label>${input}</div>`);
  }
  let saved = false;
  const m = modal(`<h2>${row ? 'Edit' : 'Add'} ${cfg.noun}</h2><form class="grid g2">${fieldHtml.join('')}<div class="actions full">${row && !cfg.noDelete && can(`${cfg.perm}.${cfg.write || 'delete'}`) ? '<button type="button" class="btn danger" data-del>Delete</button>' : ''}<button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`, { onClose: () => { if (!saved && onCancel) onCancel(); } });
  const form = $('form', m.el);
  $$('[data-img]', m.el).forEach((w) => {
    const img = $('img', w), file = $('input[type=file]', w), hid = $('input[type=hidden]', w), clr = $('[data-clr]', w);
    file.onchange = () => {
      const f = file.files[0]; if (!f) return;
      const fr = new FileReader();
      fr.onload = () => { const im = new Image(); im.onload = () => {
        const k = Math.min(1, 520 / Math.max(im.width, im.height)), c = document.createElement('canvas');
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        hid.value = c.toDataURL('image/png'); img.src = hid.value; img.classList.remove('hidden'); clr.classList.remove('hidden');
      }; im.src = fr.result; };
      fr.readAsDataURL(f);
    };
    clr.onclick = () => { hid.value = ''; img.classList.add('hidden'); clr.classList.add('hidden'); file.value = ''; };
  });
  $('[data-x]', m.el).onclick = m.close;
  if ($('[data-del]', m.el)) $('[data-del]', m.el).onclick = guard(async () => {
    if (!(await confirmBox(`Delete this ${cfg.noun}?`))) return;
    await api(`${cfg.api}/${row.id}`, { method: 'DELETE' }); saved = true; m.close(); toast('Deleted'); cfg.after && (await cfg.after()); done(null);
  });
  cfg.onOpen && cfg.onOpen(form);
  form.onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = {};
    for (const f of cfg.fields) {
      const inp = form.elements[f.k];
      if (f.t === 'checkbox') body[f.k] = inp.checked;
      else if (f.t === 'multi') body[f.k] = JSON.parse(inp.value || '[]');
      else if (f.t === 'number') body[f.k] = inp.value === '' ? 0 : +inp.value;
      else if (f.t === 'password' && !inp.value) continue;
      else body[f.k] = inp.value;
    }
    const res = await api(row ? `${cfg.api}/${row.id}` : cfg.api, { method: row ? 'PUT' : 'POST', body });
    saved = true; m.close(); toast('Saved'); cfg.after && (await cfg.after()); done(res);
  });
}

/* ------------------------------------------------------------ tasks */
const TASK_PRI = [{ v: 'high', l: 'High' }, { v: 'medium', l: 'Medium' }, { v: 'low', l: 'Low' }];
const TASK_ST = [{ v: 'todo', l: 'To do' }, { v: 'in_progress', l: 'In progress' }, { v: 'done', l: 'Done' }];
CFG.tasks = {
  title: 'Tasks', api: '/tasks', perm: 'tasks', noun: 'task',
  fields: [
    { k: 'title', l: 'Title', req: 1, full: 1 }, { k: 'description', l: 'Description', t: 'textarea', full: 1 },
    { k: 'due_date', l: 'Due date', t: 'date' }, { k: 'assignees', l: 'Assigned to', t: 'multi', val: (r) => (r.assignees || []).map((a) => a.id) },
    { k: 'priority', l: 'Priority', t: 'select', opts: TASK_PRI }, { k: 'status', l: 'Status', t: 'select', opts: TASK_ST },
  ],
  defaults: { priority: 'medium', status: 'todo' },
  onOpen(form) {
    const dot = (k) => (o) => (o.value ? `<span class="pm-l ${k}-${o.value} pm-c"><span class="tdot"></span></span><span>${esc(o.text)}</span>` : `<span>${esc(o.text)}</span>`);
    const person = (o) => +o.value === S.user.id ? `<span class="pm-l">${youChip(`${esc(o.text)} <small class="muted">(you)</small>`)}</span>` : `<span class="pm-l">${o.value ? avatar(o.text, 'xs') : '<span class="av xs none">?</span>'}<span class="${o.value ? '' : 'muted'}">${esc(o.text)}${+o.value === S.user.id ? ' <small class="muted">(you)</small>' : ''}</span></span>`;
    fancySelect(form.elements.priority, dot('priority')); fancySelect(form.elements.status, dot('status')); multiPeople(form.elements.assignees);
  },
};
// Avatars + names for a list of people ("You" first)
const peopleChips = (list, max = 2) => {
  if (!list.length) return '<span class="av xs none">?</span><span class="muted">Unassigned</span>';
  const sorted = [...list].sort((a, b) => (b.id === S.user.id) - (a.id === S.user.id));
  const names = sorted.map((p) => (p.id === S.user.id ? 'You' : p.name));
  return `<span class="avstack">${sorted.slice(0, 3).map((p) => (p.id === S.user.id ? `<span class="av xs you">${esc(initials(S.user.name))}</span>` : avatar(p.name, 'xs'))).join('')}</span>
    <span class="pp-names" title="${esc(names.join(', '))}">${esc(names.slice(0, max).join(', '))}${names.length > max ? ` <small class="muted">+${names.length - max}</small>` : ''}</span>`;
};
const personOpt = (p) => `<span class="pm-l">${p.id === S.user.id ? youChip(`${esc(p.name)} <small class="muted">(you)</small>`) : `${avatar(p.name, 'xs')}<span>${esc(p.name)}</span>`}</span>`;
// Multi-person picker over a hidden JSON input (task form "Assigned to")
async function multiPeople(inp) {
  if (!inp) return;
  const people = await api('/tasks/people'), b = document.createElement('button');
  b.type = 'button'; b.className = 'fsel'; b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', 'Assigned to');
  const val = () => JSON.parse(inp.value || '[]').map(Number);
  const paint = () => { b.innerHTML = `<span class="fsel-v">${peopleChips(people.filter((p) => val().includes(p.id)), 3)}</span><svg class="tcaret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`; };
  inp.after(b); paint();
  b.onclick = () => {
    if (b.getAttribute('aria-expanded') === 'true') return $$('.pmenu').forEach((m) => m.remove()), b.setAttribute('aria-expanded', 'false');
    pickMenu(b, people.map((p) => ({ v: p.id, html: personOpt(p) })), val(), (ids) => { inp.value = JSON.stringify(ids.map(Number)); paint(); }, { multi: true });
    const m = $('.pmenu'); if (m) m.style.minWidth = b.offsetWidth + 'px';
  };
}
// Replace a native <select> with a button that opens pickMenu; the select stays (hidden) as the form value.
function fancySelect(sel, render) {
  if (!sel) return;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'fsel'; b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false');
  const lab = sel.closest('.field')?.querySelector('label'); if (lab) b.setAttribute('aria-label', lab.textContent);
  const paint = () => { const o = sel.options[sel.selectedIndex]; b.innerHTML = `<span class="fsel-v">${o ? render(o) : ''}</span><svg class="tcaret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`; };
  sel.hidden = true; sel.after(b); paint();
  b.onclick = () => {
    if (b.getAttribute('aria-expanded') === 'true') return $$('.pmenu').forEach((m) => m.remove()), b.setAttribute('aria-expanded', 'false');
    pickMenu(b, [...sel.options].map((o) => ({ v: o.value, html: render(o) })), sel.value, (v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); paint(); });
    const m = $('.pmenu'); if (m) m.style.minWidth = b.offsetWidth + 'px';
  };
}
// Small floating option menu anchored to a button (used by the task table pills)
function pickMenu(anchor, opts, cur, onPick, { multi = false } = {}) {
  const sel = new Set(multi ? (cur || []).map(String) : [String(cur)]), start = [...sel].sort().join();
  $$('.pmenu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'pmenu'; m.setAttribute('role', 'listbox');
  if (multi) m.setAttribute('aria-multiselectable', 'true');
  m.innerHTML = opts.map((o, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${sel.has(String(o.v))}" class="${sel.has(String(o.v)) ? 'on' : ''} ${multi ? 'multi' : ''}">${o.html}<span class="pm-check">${ic('check', 15)}</span></button>`).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  m.style.top = (r.bottom + h + 8 > innerHeight && r.top > h + 8 ? r.top - h - 6 : r.bottom + 6) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => m.classList.add('open'));
  const close = () => { if (!m.isConnected) return; m.remove(); if (multi && [...sel].sort().join() !== start) onPick([...sel]); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', out, true); document.removeEventListener('keydown', key, true); removeEventListener('scroll', close, true); removeEventListener('resize', close); };
  const out = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) close(); };
  const btns = $$('button', m), focus = (i) => btns[(i + btns.length) % btns.length].focus();
  const key = (e) => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { close(); anchor.focus(); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowDown') { focus(i + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { focus(i - 1); e.preventDefault(); }
  };
  document.addEventListener('mousedown', out, true); document.addEventListener('keydown', key, true);
  addEventListener('scroll', close, true); addEventListener('resize', close);
  btns.forEach((b) => (b.onclick = () => {
    const o = opts[+b.dataset.i];
    if (multi) { const k = String(o.v), on = !sel.has(k); on ? sel.add(k) : sel.delete(k); b.classList.toggle('on', on); b.setAttribute('aria-selected', on); return; }
    close(); if (String(o.v) !== String(cur)) onPick(o.v);
  }));
  (btns.find((b) => b.classList.contains('on')) || btns[0]).focus();
}
// Tasks page filters: a view tab plus search / status / priority (kept while you move around the app)
const TASK_F = { tab: 'all', q: '', status: '', priority: '' };
const TASK_TABS = [{ v: 'all', l: 'All tasks' }, { v: 'mine', l: 'Assigned to me' }, { v: 'byme', l: 'Assigned by me' }, { v: 'overdue', l: 'Overdue' }, { v: 'done', l: 'Completed' }];
async function viewTasks(el) {
  const all_ = await api('/tasks'), me = S.user.id, F = TASK_F, t0 = todayStr();
  const mine = (r) => r.assignees.some((a) => a.id === me);
  const inTab = (r, tab) => ({ all: true, mine: mine(r), byme: r.assigned_by === me, overdue: r.status !== 'done' && r.due_date && r.due_date < t0, done: r.status === 'done' }[tab]);
  const q = F.q.trim().toLowerCase();
  const rows = all_.filter((r) => inTab(r, F.tab) && (!F.status || r.status === F.status) && (!F.priority || r.priority === F.priority)
    && (!q || [r.title, r.description, r.assigned_by_name, ...r.assignees.map((a) => a.name)].some((v) => (v || '').toLowerCase().includes(q))));
  const pg = paginate(['tasks', F.tab, F.status, F.priority].join('-'), rows);
  // filter buttons that open the same option menu as the table pills
  const fbtn = (k, l, opts) => { const cur = opts.find((o) => o.v === F[k]);
    return `<button type="button" class="tfbtn ${cur ? 'set' : ''}" data-f="${k}" aria-haspopup="listbox" aria-expanded="false">${cur ? `<span class="pm-c ${k}-${cur.v}"><span class="tdot"></span></span>` : ''}<span class="tf-l">${l}</span><b>${cur ? cur.l : 'All'}</b><svg class="tcaret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>`; };
  // the assigner (or an org admin) manages the task; the assignee can only move its status
  const manage = (r) => S.user.isAdmin || r.assigned_by === me;
  const canStatus = (r) => manage(r) || mine(r);
  const caret = '<svg class="tcaret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const pill = (r, k, opts, editable) => {
    const lb = opts.find((o) => o.v === r[k])?.l || '';
    return editable
      ? `<button type="button" class="tpill ${k}-${esc(r[k])}" data-id="${r.id}" data-k="${k}" aria-haspopup="listbox" aria-expanded="false" aria-label="${k === 'status' ? 'Status' : 'Priority'}: ${lb}"><span class="tdot"></span>${lb}${caret}</button>`
      : `<span class="tpill ro ${k}-${esc(r[k])}"><span class="tdot"></span>${lb}</span>`;
  };
  const due = (r) => {
    if (!r.due_date) return '<span class="muted">—</span>';
    const days = Math.round((new Date(r.due_date) - new Date(todayStr())) / 864e5), open = r.status !== 'done';
    const note = !open ? '' : days < 0 ? `<small class="tlate">${-days}d overdue</small>` : days === 0 ? '<small class="tsoon">Due today</small>' : days <= 3 ? `<small class="tsoon">In ${days}d</small>` : '';
    return `<div class="tdue">${dmy(r.due_date)}${note}</div>`;
  };
  const who = (name) => (name ? `${avatar(name, 'xs')}<span>${esc(name)}</span>` : '<span class="av xs none">?</span><span class="muted">Unassigned</span>');
  // you appear as "You" (e.g. in Assigned by on tasks you created)
  const person = (id, name) => `<div class="tperson" title="${esc(name || '')}">${id === me ? youChip() : who(name)}</div>`;
  const assignee = (r) => (manage(r)
    ? `<button type="button" class="tperson tpick" data-id="${r.id}" data-k="assignees" aria-haspopup="listbox" aria-expanded="false" aria-label="Assigned to: ${esc(r.assignees.map((a) => a.name).join(', ') || 'Unassigned')}">${peopleChips(r.assignees)}${caret}</button>`
    : `<div class="tperson">${peopleChips(r.assignees)}</div>`);
  el.innerHTML = `<div class="pagehead"><h1>Tasks</h1>
      ${can('tasks.create') ? `<button class="btn primary" id="add">${ic('plus')} Add task</button>` : ''}</div>
    ${all_.length ? `<div class="ttabs" role="tablist">${TASK_TABS.map((t) => `<button type="button" role="tab" aria-selected="${F.tab === t.v}" class="${F.tab === t.v ? 'on' : ''}" data-tab="${t.v}">${t.v === 'all' && !S.user.isAdmin ? 'My tasks' : t.l}<span class="tcount">${all_.filter((r) => inTab(r, t.v)).length}</span></button>`).join('')}</div>
    <div class="tfilters"><label class="tsearch">${ic('search', 16)}<input id="tq" type="search" placeholder="Search tasks or people…" value="${esc(F.q)}" aria-label="Search tasks"></label>
      ${fbtn('status', 'Status', TASK_ST)}${fbtn('priority', 'Priority', TASK_PRI)}
      ${F.q || F.status || F.priority ? '<button type="button" class="btn sm" id="tclr">Clear</button>' : ''}</div>` : ''}
    ${rows.length ? `<div class="card tablewrap" style="padding:0"><table class="stackable tasktable"><thead><tr><th>Title</th><th>Description</th><th>Due date</th><th>Priority</th><th>Status</th><th>Assigned to</th><th>Assigned by</th><th></th></tr></thead><tbody>
      ${pg.rows.map((r) => `<tr class="${r.status === 'done' ? 'tdone' : ''}"><td class="first" data-label="Title"><span class="ttitle">${esc(r.title)}</span></td>
        <td data-label="Description" class="tdesc">${r.description ? `<span title="${esc(r.description)}">${esc(r.description)}</span>` : '<span class="muted">—</span>'}</td>
        <td data-label="Due date" class="nowrap">${due(r)}</td>
        <td data-label="Priority">${pill(r, 'priority', TASK_PRI, manage(r))}</td><td data-label="Status">${pill(r, 'status', TASK_ST, canStatus(r))}</td>
        <td data-label="Assigned to">${assignee(r)}</td><td data-label="Assigned by">${person(r.assigned_by, r.assigned_by_name)}</td>
        <td class="acts nowrap">${manage(r) ? `<button class="ibtn tact" data-e="${r.id}" title="Edit" aria-label="Edit task">${ic('edit', 16)}</button>${can('tasks.delete') ? `<button class="ibtn tact bad" data-d="${r.id}" title="Delete" aria-label="Delete task">${ic('trash', 16)}</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div>${pg.html}`
      : `<div class="empty card">${ic('check', 28)}<p>${all_.length ? 'No tasks match these filters.' : 'No tasks yet.'}</p></div>`}`;
  const reload = () => viewTasks(el);
  el.classList.add('still'); // filter changes re-render in place, without the page fade
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { F.tab = b.dataset.tab; reload(); }));
  if ($('#tq', el)) {
    let tm; $('#tq', el).oninput = (e) => { clearTimeout(tm); tm = setTimeout(async () => { F.q = e.target.value; await reload(); const i = $('#tq', el); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    $$('[data-f]', el).forEach((b) => (b.onclick = () => {
      if (b.getAttribute('aria-expanded') === 'true') return $$('.pmenu').forEach((m) => m.remove()), b.setAttribute('aria-expanded', 'false');
      const k = b.dataset.f, list = k === 'status' ? TASK_ST : TASK_PRI;
      const opts = [{ v: '', html: `<span class="pm-l pm-c pm-all"><span class="tdot"></span></span><span>All ${k === 'status' ? 'statuses' : 'priorities'}</span>` },
        ...list.map((o) => ({ v: o.v, html: `<span class="pm-l ${k}-${o.v} pm-c"><span class="tdot"></span></span><span>${o.l}</span><span class="pm-n">${all_.filter((r) => inTab(r, F.tab) && r[k] === o.v).length}</span>` }))];
      pickMenu(b, opts, F[k], (v) => { F[k] = v; reload(); });
    }));
    if ($('#tclr', el)) $('#tclr', el).onclick = () => { Object.assign(F, { q: '', status: '', priority: '' }); reload(); };
  }
  pg.bind(el, reload);
  if ($('#add', el)) $('#add', el).onclick = () => crudForm(CFG.tasks, null, reload);
  $$('[data-e]', el).forEach((b) => (b.onclick = () => crudForm(CFG.tasks, rows.find((r) => r.id === +b.dataset.e), reload)));
  $$('[data-d]', el).forEach((b) => (b.onclick = guard(async () => {
    if (!(await confirmBox('Delete this task?'))) return;
    await api('/tasks/' + b.dataset.d, { method: 'DELETE' }); toast('Deleted'); reload();
  })));
  const save = guard(async (id, k, v) => {
    try { await api('/tasks/' + id, { method: 'PUT', body: { [k]: v } }); toast('Task updated'); } finally { reload(); }
  });
  let people;
  $$('button.tpill, button.tpick', el).forEach((b) => (b.onclick = guard(async () => {
    if (b.getAttribute('aria-expanded') === 'true') return $$('.pmenu').forEach((m) => m.remove()), b.setAttribute('aria-expanded', 'false');
    const r = rows.find((x) => x.id === +b.dataset.id), k = b.dataset.k;
    let opts;
    if (k === 'assignees') {
      people = people || (await api('/tasks/people'));
      // assignees outside your pickable list (e.g. an admin, for a team member) stay as they are
      const keep = r.assignees.filter((a) => !people.some((p) => p.id === a.id)).map((a) => a.id);
      return pickMenu(b, people.map((p) => ({ v: p.id, html: personOpt(p) })), r.assignees.map((a) => a.id), (ids) => save(r.id, 'assignees', [...keep, ...ids.map(Number)]), { multi: true });
    } else opts = (k === 'status' ? TASK_ST : TASK_PRI).map((o) => ({ v: o.v, html: `<span class="pm-l ${k}-${o.v} pm-c"><span class="tdot"></span></span><span>${o.l}</span>` }));
    pickMenu(b, opts, r[k] ?? '', (v) => save(r.id, k, v));
  })));
}

/* ------------------------------------------------------------ settings */
// Settings → General: the organisation's details (shown on invoices) with one Add / Edit button
async function orgDetailsCard(el) {
  const o = (await api('/organisations'))[0], edit = can('settings.edit');
  const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v ? esc(v) : '<span class="muted">—</span>'}</b></div>`;
  el.innerHTML = `<div class="pagehead"><h2>Organisation details</h2>${edit ? `<button class="btn primary" id="od-edit">${o ? `${ic('edit', 15)} Edit details` : `${ic('plus', 15)} Add details`}</button>` : ''}</div>
    ${o ? `<div class="card od-card orgd">${o.logo ? `<img class="orgd-logo" src="${esc(o.logo)}" alt="">` : ''}<div class="orgd-grid">
      ${kv('Name', o.name)}${kv('GSTIN', o.gst_number)}${kv('PAN', o.pan_number)}${kv('State', o.state && `${o.state}${o.state_code ? ` (${o.state_code})` : ''}`)}
      ${kv('Email', o.email)}${kv('Phone', o.contact)}${kv('UPI ID', o.upi_id)}${kv('Bank details', o.bank_details ? 'Added' : '')}${kv('Address', o.address)}</div></div>`
      : '<div class="empty card">No organisation details yet.</div>'}`;
  if ($('#od-edit', el)) $('#od-edit', el).onclick = () => crudForm({ ...CFG.organisations, noun: 'organisation details', noDelete: true }, o || null, () => orgDetailsCard(el));
}

// Settings has tabs: General, Templates and Activity log (the last two used to be sidebar pages)
async function viewSettings(el, tab) {
  const tabs = [can('settings.view') || S.user.isAdmin ? { id: 'general', l: 'General', h: '#/settings' } : null, can('users.view') ? { id: 'users', l: 'Users', h: '#/users' } : null, can('templates.view') ? { id: 'templates', l: 'Templates', h: '#/templates' } : null, can('activity.view') ? { id: 'activity', l: 'Activity log', h: '#/activity' } : null].filter(Boolean);
  if (!tabs.length) { el.innerHTML = '<div class="empty card">You don\'t have access to this page.</div>'; return; }
  const cur = tabs.find((t) => t.id === tab) || tabs[0];
  el.innerHTML = `<div class="pagehead"><h1>Settings</h1></div>
    <div class="settabs">${tabs.map((t) => `<a class="${t.id === cur.id ? 'on' : ''}" href="${t.h}">${t.l}</a>`).join('')}</div><div id="stab"></div>`;
  const body = $('#stab', el);
  if (cur.id === 'users') return crudView(body, CFG.users);
  if (cur.id === 'templates') return crudView(body, CFG.templates);
  if (cur.id === 'activity') return viewActivity(body);
  body.innerHTML = `${S.user.isAdmin ? '<div id="s0" style="margin-top:22px"></div>' : ''}<div id="s1" style="margin-top:22px"></div><div id="s2" style="margin-top:22px"></div>`;
  if (S.user.isAdmin) await inviteCard($('#s0'));
  if (can('settings.view')) { await orgDetailsCard($('#s1')); await crudView($('#s2'), CFG.ccEmails); }
}

/* ------------------------------------------------------------ public client page (/p/<token>) */
async function publicView(token) {
  const app = $('#app');
  app.innerHTML = `<div class="pub">${skeleton('detail')}</div>`;
  try {
    const res = await fetch('/api/public/invoice/' + encodeURIComponent(token));
    const v = await res.json();
    if (!res.ok) throw new Error(v.error || 'Invoice not found');
    const isTax = v.invoice_type === 'tax';
    const due = isTax ? Math.max(0, v.balance_amount) : v.net_amount;
    document.title = `${v.invoice_number} · ${v.org_name}`;
    setTimeout(() => bindDocToggle($('#app')), 0);
    app.innerHTML = `<div class="pub"><div class="pub-bar noprint"><div class="brand">${LOGO} ${esc(v.org_name)}</div>
        <div class="row"><button class="btn sm" data-theme-btn aria-label="Toggle theme">${themeIcon()}</button><button class="btn" onclick="window.print()">${ic('download')} PDF</button>
        ${v.upi_link && due > 0.005 ? `<a class="btn primary" href="${esc(v.upi_link)}">Pay ${money(due)} via UPI</a>` : ''}</div></div>
      ${isTax ? `<div class="card paycard noprint"><div class="row sp"><h2>${esc(v.invoice_number)}</h2><span class="pill ${v.payment_status}">${v.payment_status === 'paid' ? 'paid' : v.payment_status}</span></div>
        <div class="grid g3" style="margin:12px 0 10px"><div><div class="small muted">Invoice amount</div><div class="big">${money(v.net_amount - (v.credit_amount || 0))}</div></div>
        <div><div class="small muted">Paid</div><div class="big" style="color:var(--ok)">${money(v.paid_amount)}</div></div>
        <div><div class="small muted">Balance due</div><div class="big" style="color:${due > 0.005 ? 'var(--bad)' : 'var(--ok)'}">${money(due)}</div></div></div>
        ${progress(v.paid_amount, v.net_amount - (v.credit_amount || 0))}${v.due_date && due > 0.005 ? `<div class="small muted" style="margin-top:6px">Due ${dmy(v.due_date)}</div>` : ''}</div>` : ''}
      ${docBlockHtml(v)}<p class="muted small noprint" style="text-align:center;margin-top:16px">Questions? Contact ${esc(v.org_name)}${v.org_contact ? ' · ' + esc(v.org_contact) : ''}${v.org_email ? ' · ' + esc(v.org_email) : ''}</p></div>`;
  } catch (e) {
    app.innerHTML = `<div class="pub"><div class="card empty"><h2>Link not available</h2><p>${esc(e.message)}</p></div></div>`;
  }
}

/* ------------------------------------------------------------ credit note view */
async function viewCreditNote(el, id) {
  const c = await api('/credit-notes/' + id), v = c.invoice;
  el.innerHTML = `<div class="pagehead noprint"><div><a href="#/invoices/${v.id}" class="small">← ${esc(v.invoice_number)}</a><h1 class="keep">${esc(c.number)}</h1></div>
      <button class="btn" onclick="window.print()">${ic('printer')} PDF</button></div>
    <div class="doc tax"><div class="in">
      <div class="top-h"><div class="logo-box">${v.org_logo ? `<img src="${esc(v.org_logo)}" alt="">` : `<div class="nm">${esc((v.org_name || '').toUpperCase())}</div>`}</div>
        <div><div class="ttl">CREDIT NOTE</div><div class="meta"><b>Note No:</b> ${esc(c.number)}<br><b>Date:</b> ${dmy(c.note_date)}<br><b>Against invoice:</b> ${esc(v.invoice_number)} (${dmy(v.invoice_date)})</div></div></div>
      <div class="two"><div><div class="secbar">Issued By</div><div class="kv"><div><b>${esc(v.org_name)}</b></div>${v.org_gst ? `<div><b>GST No:</b> ${esc(v.org_gst)}</div>` : ''}</div></div>
        <div><div class="secbar">Issued To</div><div class="kv"><div><b>${esc(v.client_name)}</b></div><div><b>GST Number:</b> ${esc(v.client_gst || 'N/A')}</div></div></div></div>
      <div class="tablewrap"><table class="it"><thead><tr><th>Reason</th><th class="num">Taxable value</th><th class="num">GST %</th><th class="num">Tax</th><th class="num">Credit amount</th></tr></thead><tbody>
        <tr><td>${esc(c.reason || 'Credit against invoice ' + v.invoice_number)}</td><td class="num">${money(c.taxable)}</td><td class="num">${c.tax_rate}%</td><td class="num">${money(c.igst + c.cgst + c.sgst)}</td><td class="num">${money(c.total)}</td></tr></tbody></table></div>
      <div class="lower"><div></div><div class="sum"><div class="l"><span>Taxable Amount</span><b>${money(c.taxable)}</b></div>
        ${c.igst ? `<div class="l"><span>IGST</span><b>${money(c.igst)}</b></div>` : `<div class="l"><span>CGST</span><b>${money(c.cgst)}</b></div><div class="l"><span>SGST</span><b>${money(c.sgst)}</b></div>`}
        <div class="l g"><span>Total Credit</span><span>${money(c.total)}</span></div></div></div>
      <div class="sign"><div>${v.org_signature ? `<img src="${esc(v.org_signature)}" alt="">` : '<div style="height:50px"></div>'}<div class="ln">Authorized Signature</div></div></div>
    </div><div class="thanks">${esc(v.org_footer || 'Thank you!')}</div></div>`;
}

/* ------------------------------------------------------------ recurring invoices */
const FREQS = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly' };
const nextPeriod = (d, f) => {
  const x = new Date(d + 'T00:00:00Z');
  if (f === 'weekly') x.setUTCDate(x.getUTCDate() + 7); else x.setUTCMonth(x.getUTCMonth() + { monthly: 1, quarterly: 3, yearly: 12 }[f]);
  return x.toISOString().slice(0, 10);
};
function recurringModal(cfg, done) {
  const r = cfg.row;
  const m = modal(`<h2>${r ? 'Edit schedule' : 'Make this invoice recurring'}</h2>
    ${!r ? `<p class="muted small">A new invoice with the same items is created automatically on each date. You then send it with one tap.</p>` : ''}
    <form class="grid g2"><div class="field"><label>Repeat</label><select name="frequency">${Object.entries(FREQS).map(([k, l]) => `<option value="${k}" ${(r?.frequency || 'monthly') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label>Next invoice on</label><input type="date" name="next_run" value="${r?.next_run || nextPeriod(cfg.invoice_date, 'monthly')}" required></div>
    <div class="field"><label>Payment due after (days)</label><input type="number" name="due_days" min="0" value="${r?.due_days ?? cfg.due_days ?? 7}"></div>
    <div class="field"><label>Stop after (optional)</label><input type="date" name="end_date" value="${r?.end_date || ''}"></div>
    <div class="actions full"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${r ? 'Save' : 'Start schedule'}</button></div></form>`);
  const f = $('form', m.el);
  $('[data-x]', m.el).onclick = m.close;
  if (!r) f.frequency.onchange = () => { f.next_run.value = nextPeriod(cfg.invoice_date, f.frequency.value); };
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = { frequency: f.frequency.value, next_run: f.next_run.value, due_days: +f.due_days.value, end_date: f.end_date.value || null };
    if (r) await api('/recurring/' + r.id, { method: 'PUT', body }); else await api('/recurring', { method: 'POST', body: { ...body, source_invoice_id: cfg.invoice_id } });
    m.close(); toast(r ? 'Schedule updated' : 'Recurring schedule started'); done();
  });
}
async function viewRecurring(el) {
  const list = await api('/recurring'), pg = paginate('rec', list);
  el.innerHTML = `<div class="pagehead"><div><h1>Recurring invoices</h1><div class="muted small">Invoices are generated automatically on schedule (checked hourly while the server runs). Open a tax invoice and tap “Recurring” to add one.</div></div></div>
    <div class="stack">${list.length ? pg.rows.map((r) => `<div class="card"><div class="row sp"><div><h3>${esc(r.client_name)}</h3><div class="small muted">${esc(r.org_name)} · ${FREQS[r.frequency]} · ~${money(r.estimate)} per invoice</div></div>
      <span class="pill ${r.active ? 'paid' : 'partial'}">${r.active ? 'Active' : r.end_date && r.next_run > r.end_date ? 'Ended' : 'Paused'}</span></div>
      <div class="grid g3" style="margin:12px 0"><div><div class="small muted">Next invoice</div><b>${dmy(r.next_run)}</b></div><div><div class="small muted">Generated so far</div><b>${r.run_count}</b></div>
        <div><div class="small muted">Due after</div><b>${r.due_days} days</b>${r.end_date ? `<div class="small muted">until ${dmy(r.end_date)}</div>` : ''}</div></div>
      <div class="row">${can('recurring.edit') ? `<button class="btn sm" data-run="${r.id}">Generate now</button><button class="btn sm" data-tg="${r.id}" data-on="${r.active}">${r.active ? 'Pause' : 'Resume'}</button><button class="btn sm" data-ed="${r.id}">Edit</button>` : ''}
        ${r.last_invoice_id ? `<a class="btn sm" href="#/invoices/${r.last_invoice_id}">Last invoice →</a>` : ''}${can('recurring.delete') ? `<button class="btn sm danger" data-del="${r.id}">Delete</button>` : ''}</div></div>`).join('') + pg.html : '<div class="empty card">No recurring invoices yet.</div>'}</div>`;
  const again = () => viewRecurring(el);
  pg.bind(el, again);
  $$('[data-run]', el).forEach((b) => (b.onclick = guard(async () => { if (!(await confirmBox('Generate the next invoice now (dated today)?'))) return; const r = await api(`/recurring/${b.dataset.run}/run`, { method: 'POST' }); toast('Invoice created'); location.hash = '#/invoices/' + r.id; })));
  $$('[data-tg]', el).forEach((b) => (b.onclick = guard(async () => { await api('/recurring/' + b.dataset.tg, { method: 'PUT', body: { active: b.dataset.on !== '1' } }); again(); })));
  $$('[data-ed]', el).forEach((b) => (b.onclick = () => recurringModal({ row: list.find((x) => x.id === +b.dataset.ed) }, again)));
  $$('[data-del]', el).forEach((b) => (b.onclick = guard(async () => { if (!(await confirmBox('Delete this schedule? Existing invoices stay.'))) return; await api('/recurring/' + b.dataset.del, { method: 'DELETE' }); again(); })));
}

/* ------------------------------------------------------------ GST report */
let gstRange = { key: 'month', from: null, to: null };
const GST_RANGES = { month: ['This month', () => monthBounds(0)], lmonth: ['Last month', () => monthBounds(-1)], fy: ['This financial year', () => fyBounds(0)], custom: ['Custom range', null] };
let gstTab = 'b2b';
async function viewGst(el) {
  const [f, t] = gstRange.key === 'custom' && gstRange.from ? [gstRange.from, gstRange.to] : GST_RANGES[gstRange.key][1]();
  const d = await api(`/gst/report?from=${f}&to=${t}`);
  const n = d.totals.net;
  const pg = (rows) => paginate('gst:' + gstTab, rows);
  let pgCur;
  const tbl = (cols, all) => { pgCur = pg(all); const rows = pgCur.rows; return all.length ? `<div class="card tablewrap" style="padding:0"><table><thead><tr>${cols.map((c) => `<th class="${c[2] ? 'num' : ''}">${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c[2] ? 'num' : ''}">${c[2] ? money(r[c[1]]) : esc(c[3] ? c[3](r[c[1]]) : r[c[1]] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${pgCur.html}` : '<div class="empty card">Nothing in this period.</div>'; };
  const inv = [['Invoice', 'invoice_number'], ['Date', 'invoice_date', 0, dmy], ['Client', 'client_name'], ['GSTIN', 'client_gst'], ['Rate', 'rate', 0, (v) => v + '%'], ['Taxable', 'taxable', 1], ['CGST', 'cgst', 1], ['SGST', 'sgst', 1], ['IGST', 'igst', 1], ['Total', 'total', 1]];
  el.innerHTML = `<div class="pagehead"><div><h1>GST report</h1><div class="muted small">${dmy(f)} → ${dmy(t)} · GSTR-1 style, tax invoices less credit notes</div></div>
      <div class="row"><select id="gk" style="width:auto">${Object.entries(GST_RANGES).map(([k, v]) => `<option value="${k}" ${k === gstRange.key ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      ${can('gst.export') ? `<button class="btn primary" id="gx">${ic('download')} Excel</button>` : ''}</div></div>
    <div class="row hidden" id="gcr" style="margin-bottom:14px"><input type="date" id="gf" value="${f}" style="width:auto"><span>to</span><input type="date" id="gt" value="${t}" style="width:auto"><button class="btn sm primary" id="gg">Apply</button></div>
    <div class="grid g4"><div class="card kpi"><div class="label">Taxable value (net)</div><div class="val">${money(n.taxable)}</div><div class="sub">${d.b2b.length + d.b2c.length} invoice lines</div></div>
      <div class="card kpi"><div class="label">CGST + SGST</div><div class="val">${money(n.cgst + n.sgst)}</div><div class="sub">CGST ${money(n.cgst)} · SGST ${money(n.sgst)}</div></div>
      <div class="card kpi"><div class="label">IGST</div><div class="val">${money(n.igst)}</div></div>
      <div class="card kpi"><div class="label">Total GST payable</div><div class="val">${money(n.cgst + n.sgst + n.igst)}</div><div class="sub">after credit notes ${money(d.totals.credit.cgst + d.totals.credit.sgst + d.totals.credit.igst)}</div></div></div>
    <div class="tabs" style="margin:16px 0 12px">${[['b2b', `B2B (${d.b2b.length})`], ['b2c', `B2C (${d.b2c.length})`], ['cn', `Credit notes (${d.notes.length})`], ['hsn', `HSN summary (${d.hsn.length})`]].map(([k, l]) => `<button class="tab ${gstTab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    ${gstTab === 'b2b' ? tbl(inv, d.b2b) : gstTab === 'b2c' ? tbl(inv, d.b2c) : gstTab === 'cn' ? tbl([['Note', 'number'], ['Date', 'note_date', 0, dmy], ['Invoice', 'invoice_number'], ['Client', 'client_name'], ['Rate', 'rate', 0, (v) => v + '%'], ['Taxable', 'taxable', 1], ['CGST', 'cgst', 1], ['SGST', 'sgst', 1], ['IGST', 'igst', 1], ['Total', 'total', 1]], d.notes)
      : tbl([['SAC/HSN', 'sac'], ['Rate', 'rate', 0, (v) => v + '%'], ['Qty', 'qty'], ['Taxable', 'taxable', 1], ['CGST', 'cgst', 1], ['SGST', 'sgst', 1], ['IGST', 'igst', 1], ['Total', 'total', 1]], d.hsn)}`;
  if (pgCur) pgCur.bind(el, () => viewGst(el));
  const cust = () => $('#gcr').classList.toggle('hidden', $('#gk').value !== 'custom');
  cust();
  $('#gk').onchange = () => { gstRange.key = $('#gk').value; ['b2b', 'b2c', 'cn', 'hsn'].forEach((k) => resetPg('gst:' + k)); if (gstRange.key === 'custom') cust(); else viewGst(el); };
  $('#gg').onclick = () => { ['b2b', 'b2c', 'cn', 'hsn'].forEach((k) => resetPg('gst:' + k)); gstRange ={ key: 'custom', from: $('#gf').value, to: $('#gt').value }; viewGst(el); };
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { gstTab = b.dataset.tab; viewGst(el); }));
  if ($('#gx')) $('#gx').onclick = () => download(`/gst/export.xlsx?from=${f}&to=${t}`, `GST_report_${f}_to_${t}.xlsx`);
}

/* ------------------------------------------------------------ activity log */
let actFilter = '';
async function viewActivity(el) {
  const all_ = await api('/activity' + (actFilter ? '?entity=' + encodeURIComponent(actFilter) : '')), pg = paginate('act:' + actFilter, all_), rows = pg.rows;
  const ents = ['', 'invoice', 'payment', 'credit note', 'clients', 'products', 'templates', 'expenses', 'recurring', 'user', 'role', 'message', 'organisations'];
  el.innerHTML = `<div class="pagehead"><div><h1>Activity log</h1><div class="muted small">Who did what and when — last 300 actions.</div></div>
    <select id="af" style="width:auto">${ents.map((e) => `<option value="${e}" ${e === actFilter ? 'selected' : ''}>${e || 'Everything'}</option>`).join('')}</select></div>
    ${rows.length ? `<div class="card" style="padding:4px 16px">${rows.map((r) => `<div class="list-line"><div><span class="pill">${esc(r.action)}</span> <b>${esc(r.entity)}</b> <span>${esc(r.summary || '')}</span>
      <div class="small muted">${esc(r.user_name || '')} · ${new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div></div>`).join('')}</div>${pg.html}` : '<div class="empty card">No activity yet.</div>'}`;
  pg.bind(el, () => viewActivity(el));
  $('#af').onchange = (e) => { actFilter = e.target.value; resetPg('act:' + actFilter); viewActivity(el); };
}

/* ------------------------------------------------------------ invoice-page helpers (share, credit note, receipt) */
async function shareModal(v, refresh) {
  const { url } = await api(`/invoices/${v.id}/share`, { method: 'POST' });
  const m = modal(`<h2>Share with client</h2><p class="muted small">The client opens this link without logging in, sees the invoice, downloads the PDF and pays by UPI. You can see when they open it.</p>
    <div class="field"><label>Link</label><input id="su" readonly value="${esc(url)}"></div>
    <div class="actions"><button class="btn danger" id="sd">Disable link</button><button class="btn" id="sc">Copy link</button>${can('reminders.send') ? '<button class="btn wa" id="sw">Send on WhatsApp</button><button class="btn" id="se">Email</button>' : ''}</div>`);
  $('#su', m.el).onfocus = (e) => e.target.select();
  $('#sc', m.el).onclick = () => navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => { $('#su', m.el).select(); toast('Press Ctrl+C to copy'); });
  $('#sd', m.el).onclick = guard(async () => { if (!(await confirmBox('Disable this link? Anyone who has it will lose access.'))) return; await api(`/invoices/${v.id}/share`, { method: 'DELETE' }); m.close(); toast('Link disabled'); refresh(); });
  if ($('#sw', m.el)) { $('#sw', m.el).onclick = () => { m.close(); openMessage({ client_id: v.client_id, invoice_id: v.id, channel: 'whatsapp', kind: 'invoice' }); }; $('#se', m.el).onclick = () => { m.close(); openMessage({ client_id: v.client_id, invoice_id: v.id, channel: 'email', kind: 'invoice' }); }; }
}
function creditModal(v, refresh) {
  const left = r2(v.net_amount - v.credit_amount), rate = v.items[0]?.tax || 18;
  const m = modal(`<h2>Issue credit note</h2><p class="muted small">Reduces what the client owes on ${esc(v.invoice_number)} (max ${money(left)} incl. GST). Use for discounts, returns or corrections.</p>
    <form class="grid g2"><div class="field"><label>Amount before GST</label><input type="number" name="taxable" step="0.01" min="0.01" required inputmode="decimal"></div>
    <div class="field"><label>GST %</label><input type="number" name="tax_rate" value="${rate}" step="any" min="0"></div>
    <div class="field"><label>Date</label><input type="date" name="note_date" value="${todayStr()}"></div><div class="field"><label>Reason</label><input name="reason" placeholder="e.g. Discount, service not delivered"></div>
    <div class="small muted full" id="cn-t"></div>
    <div class="actions full"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Create credit note</button></div></form>`);
  const f = $('form', m.el), calc = () => { const t = +f.taxable.value || 0; $('#cn-t', m.el).textContent = `Credit total: ${money(t + (t * (+f.tax_rate.value || 0)) / 100)}`; };
  f.oninput = calc; calc();
  $('[data-x]', m.el).onclick = m.close;
  f.onsubmit = guard(async (e) => { e.preventDefault(); const r = await api(`/invoices/${v.id}/credit-notes`, { method: 'POST', body: { taxable: f.taxable.value, tax_rate: f.tax_rate.value, note_date: f.note_date.value, reason: f.reason.value } }); m.close(); toast('Credit note created'); refresh(); location.hash = '#/credit-notes/' + r.id; });
}
function askReceipt(v, paymentId) {
  const m = modal(`<h2>Payment recorded</h2><p class="muted">Send a thank-you / receipt message to ${esc(v.client_name)}?</p>
    <div class="actions"><button class="btn" data-x>Skip</button><button class="btn" id="re">Email</button><button class="btn wa" id="rw">WhatsApp</button></div>`);
  $('[data-x]', m.el).onclick = m.close;
  const go = (channel) => () => { m.close(); openMessage({ client_id: v.client_id, invoice_id: v.id, payment_id: paymentId, kind: 'receipt', channel }); };
  $('#rw', m.el).onclick = go('whatsapp'); $('#re', m.el).onclick = go('email');
}


/* ------------------------------------------------------------ voice assistant */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const VOICE = { history: [], lang: (() => { try { return localStorage.getItem('voiceLang2') || 'en-IN'; } catch { return 'en-IN'; } })() };
const YES = /^(yes|yeah|yep|ok(ay)?|confirm|do it|haan?|haa|ha ji|haanji|ji haan|theek hai|thik hai|kar do|karo|हाँ|हां|हा|जी|ठीक है|कर दो)[\s.!।]*$/i;
const NO = /^(no|nope|cancel|stop|nahi|nahin|mat karo|rehne do|नहीं|नही|मत|रहने दो)[\s.!।]*$/i;
function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  // voice follows the reply's own script, not the mic toggle: Devanagari -> Hindi voice, anything else -> Indian English voice
  u.lang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-IN';
  const vs = speechSynthesis.getVoices();
  const v = vs.find((x) => x.lang === u.lang) || vs.find((x) => x.lang.startsWith(u.lang.slice(0, 2)));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
function openVoice() {
  if ($('.vx')) return;
  if (S.user?.membership?.status !== 'approved') return toast('Voice works inside an organisation', true);
  let rec = null, listening = false, pend = null, busy = false;
  const m = modal(`<div class="vx"><div class="row sp"><h2>Voice assistant</h2><div class="vx-lang" role="group" aria-label="Language">
        <button type="button" data-l="en-IN" title="English and Hinglish">English</button><button type="button" data-l="hi-IN" title="Hindi (Devanagari)">हिंदी</button></div></div>
      <div class="vx-log" id="vlog" aria-live="polite"><div class="vx-hint">Try: <i>"Tata Motors ka status inactive kar do"</i>, <i>"How much is overdue?"</i>, <i>"ZOHO ke invoice ka payment full receive ho gaya"</i></div></div>
      <div class="vx-live" id="vlive"></div>
      <div class="vx-bar"><button type="button" class="vx-mic" id="vmic" aria-label="Speak">${ic('mic', 30, 2.6)}</button>
        <form id="vf" class="vx-type"><input id="vt" placeholder="${SR ? 'Or type a command…' : 'Type a command (voice needs Chrome or Edge)'}" autocomplete="off" maxlength="600"><button class="btn primary sm" aria-label="Send">${ic('send', 16)}</button></form></div>
      <div class="vx-status small muted" id="vst">${SR ? 'Tap the mic and speak' : 'Speech recognition is not supported in this browser'}</div></div>`,
    { onClose: () => { try { rec && rec.abort(); } catch {} if ('speechSynthesis' in window) speechSynthesis.cancel(); } });
  const log = $('#vlog', m.el), live = $('#vlive', m.el), st = $('#vst', m.el), micB = $('#vmic', m.el);
  const setLang = (l, save) => { VOICE.lang = l; if (save) try { localStorage.setItem('voiceLang2', l); } catch {} $$('[data-l]', m.el).forEach((b) => b.classList.toggle('on', b.dataset.l === l)); };
  setLang(VOICE.lang);
  $$('[data-l]', m.el).forEach((b) => (b.onclick = () => setLang(b.dataset.l, true)));
  const bubble = (who, html) => { $('.vx-hint', log)?.remove(); const d = document.createElement('div'); d.className = 'vx-msg ' + who; d.innerHTML = html; log.append(d); log.scrollTop = log.scrollHeight; return d; };
  const status = (t) => (st.textContent = t);

  async function confirmPending(ok) {
    const p = pend; pend = null;
    $$('.vx-card button', log).forEach((b) => (b.disabled = true));
    try {
      const r = await api('/voice/confirm', { method: 'POST', body: { id: p.id, cancel: !ok } });
      bubble('bot', esc(r.reply)); speak(r.reply); VOICE.history.push({ role: 'assistant', text: r.reply });
      if (ok) {
        refreshBadge();
        if (r.compose) setTimeout(() => { m.close(); openMessage(r.compose); }, 900); // saved the missing email -> open the draft
        else if (r.open) location.hash = r.open; else if (r.refresh) route();
      }
    } catch (e) { bubble('bot err', esc(e.message)); speak(e.message); }
    status('Tap the mic to say something else');
  }
  async function send(text, retry = false) {
    text = text.trim(); if (!text || busy) return;
    if (!retry && pend && YES.test(text)) { bubble('me', esc(text)); return confirmPending(true); }
    if (!retry && pend && NO.test(text)) { bubble('me', esc(text)); return confirmPending(false); }
    if (pend) { api('/voice/confirm', { method: 'POST', body: { id: pend.id, cancel: true } }).catch(() => {}); pend = null; $$('.vx-card button', log).forEach((b) => (b.disabled = true)); }
    if (!retry) bubble('me', esc(text));
    busy = true; micB.disabled = true; status('Thinking…');
    const wait = bubble('bot wait', '<span class="vx-dots"><i></i><i></i><i></i></span>');
    try {
      const r = await api('/voice/command', { method: 'POST', body: { text, history: VOICE.history } });
      wait.remove();
      VOICE.history.push({ role: 'user', text }, { role: 'assistant', text: r.reply });
      VOICE.history = VOICE.history.slice(-8);
      const b = bubble('bot', esc(r.reply));
      speak(r.reply);
      if (r.pending) {
        pend = r.pending;
        const card = document.createElement('div'); card.className = 'vx-card';
        card.innerHTML = `<div class="small muted">Confirm this change</div><b>${esc(r.pending.summary)}</b><div class="row"><button class="btn sm" data-n>Cancel</button><button class="btn sm primary" data-y>${ic('check', 15)} Confirm</button></div>`;
        b.append(card);
        $('[data-y]', card).onclick = () => confirmPending(true);
        $('[data-n]', card).onclick = () => confirmPending(false);
        status('Say "haan / yes" to confirm, or "nahi / no" to cancel');
        log.scrollTop = log.scrollHeight;
      } else status('Tap the mic to say something else');
      if (r.navigate) setTimeout(() => (location.hash = r.navigate), 600);
      // email / WhatsApp: hand over to the normal "Send" window with the template already filled in
      if (r.compose) setTimeout(() => { m.close(); openMessage(r.compose); }, 900);
    } catch (e) {
      wait.remove();
      // failed request: offer to resend the same words without speaking again
      const b = bubble('bot err', `<div>${esc(e.message)}</div><button type="button" class="btn sm vx-retry">${ic('repeat', 14)} Retry</button>`);
      $('.vx-retry', b).onclick = () => { b.remove(); send(text, true); };
      status('Tap Retry, or speak again');
    }
    finally { busy = false; micB.disabled = false; }
  }
  function listen() {
    if (!SR) return toast('Voice input needs Chrome or Edge — you can type instead', true);
    if (listening) { rec.stop(); return; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    rec = new SR(); rec.lang = VOICE.lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '', errored = false;
    rec.onstart = () => { listening = true; micB.classList.add('on'); status(VOICE.lang === 'hi-IN' ? 'सुन रहा हूँ… (listening)' : 'Listening…'); };
    rec.onresult = (e) => { let t = ''; for (const r of e.results) { t += r[0].transcript; if (r.isFinal) finalText = t; } live.textContent = t; };
    rec.onerror = (e) => { errored = true; status(e.error === 'not-allowed' ? 'Microphone permission was blocked — allow it in the browser' : e.error === 'no-speech' ? "Didn't catch that — tap and try again" : 'Voice error: ' + e.error); };
    rec.onend = () => { listening = false; micB.classList.remove('on'); const t = (finalText || live.textContent).trim(); live.textContent = ''; if (t) send(t); else if (!errored && !busy) status('Tap the mic and speak'); };
    try { rec.start(); } catch { status('Mic is busy — try again'); }
  }
  micB.onclick = listen;
  $('#vf', m.el).onsubmit = (e) => { e.preventDefault(); const v = $('#vt', m.el).value; $('#vt', m.el).value = ''; send(v); };
  if (SR) setTimeout(listen, 250); // start listening straight away
}

/* ------------------------------------------------------------ platform management */
let mgmtQ = '';
// Platform overview: organisations and their people only (no business data reaches management)
async function viewManagement(el) {
  const d = await api('/management/organisations');
  const tile = (icn, tone, label, val) => `<div class="stat ${tone}"><span class="stat-ic">${ic(icn, 19)}</span><div class="stat-b"><div class="stat-l">${label}</div><div class="stat-v">${val}</div></div></div>`;
  const mods = (r) => d.modules.filter((m) => r.modules.includes(m.id)).map((m) => m.label).join(', ');
  const draw = () => {
    const q = mgmtQ.toLowerCase();
    const rows = d.rows.filter((r) => !q || `${r.name} ${r.creator_email} ${r.invite_code} ${r.gst_number || ''}`.toLowerCase().includes(q));
    const pg = paginate('mgmt', rows);
    $('#mt', el).innerHTML = rows.length ? `<div class="card tablewrap" style="padding:0"><table class="stackable mgmt"><thead><tr>
        <th>Organisation</th><th>Status</th><th>Created by</th><th class="num">Members</th><th class="num">Pending</th><th>Modules</th><th></th></tr></thead><tbody>
      ${pg.rows.map((r) => `<tr><td class="first" data-label="Organisation"><b>${esc(r.name)}</b>${r.gst_number ? `<div class="small muted">${esc(r.gst_number)}</div>` : ''}</td>
        <td data-label="Status">${r.active ? '<span class="pill paid">Active</span>' : '<span class="pill unpaid">Deactivated</span>'}</td>
        <td data-label="Created by">${esc(r.creator_name || '—')}<div class="small muted">${esc(r.creator_email || '')} · ${fmtLong(r.created_at)}</div></td>
        <td class="num" data-label="Members">${r.members}<div class="small muted">${r.admins} admin</div></td>
        <td class="num" data-label="Pending">${r.pending ? `<span class="pill partial">${r.pending}</span>` : 0}${r.rejected ? `<div class="small muted">${r.rejected} rejected</div>` : ''}</td>
        <td data-label="Modules" class="small">${esc(mods(r))}</td>
        <td class="acts nowrap"><button class="btn sm" data-view="${r.id}">${ic('users', 15)} Members</button></td></tr>`).join('')}</tbody></table></div>${pg.html}`
      : '<div class="empty card">No organisations match.</div>';
    pg.bind(el, draw);
    $$('[data-view]', el).forEach((b) => (b.onclick = guard(() => orgDetails(+b.dataset.view, d.modules))));
  };
  el.innerHTML = `<div class="pagehead"><h1>Dashboard</h1>
      <button class="btn" id="mx">${ic('download')} Export CSV</button></div>
    <div class="mgmt-stats">${tile('grid', 'brand', 'Organisations', d.totals.organisations)}${tile('check', 'ok', 'Active organisations', d.totals.active)}
      ${tile('users', 'ok', 'Members', d.totals.members)}${tile('clock', 'bad', 'Pending requests', d.totals.pending)}${tile('user', 'grey', 'User accounts', d.totals.users)}</div>
    <div class="inwrap" style="margin:16px 0 12px;max-width:360px">${ic('search', 18)}<input id="mq" placeholder="Search organisation, email, code…" value="${esc(mgmtQ)}"></div>
    <div id="mt"></div>`;
  $('#mq', el).oninput = (e) => { mgmtQ = e.target.value; resetPg('mgmt'); draw(); };
  $('#mx', el).onclick = () => {
    const head = ['Organisation', 'Status', 'GSTIN', 'Created by', 'Creator email', 'Created', 'Invite code', 'Members', 'Admins', 'Pending', 'Rejected', 'Modules'];
    const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [head, ...d.rows.map((r) => [r.name, r.active ? 'active' : 'deactivated', r.gst_number, r.creator_name, r.creator_email, r.created_at, r.invite_code, r.members, r.admins, r.pending, r.rejected, mods(r)])];
    downloadBlob(new Blob(['﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }), 'organisations.csv');
  };
  draw();
}

/* ------------------------------------------------------------ management: organisations (modules, status, delete) */
async function viewOrgControl(el) {
  const d = await api('/management/organisations');
  const toggle = (r, m) => `<label class="mswitch" title="${esc(m.label)}"><input type="checkbox" data-org="${r.id}" data-mod="${m.id}" ${r.modules.includes(m.id) ? 'checked' : ''}><span class="ms-track"><span class="ms-knob"></span></span><span>${esc(m.label)}</span></label>`;
  el.innerHTML = `<div class="pagehead"><h1>Organisations</h1></div>
    ${d.rows.length ? `<div class="card tablewrap" style="padding:0"><table class="stackable orgctl"><thead><tr><th>Organisation</th><th>Status</th><th>Modules</th><th class="num">Members</th><th></th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr class="${r.active ? '' : 'off'}"><td class="first" data-label="Organisation"><b>${esc(r.name)}</b><div class="small muted">${esc(r.creator_email || '')}</div></td>
        <td data-label="Status">${r.active ? '<span class="pill paid">Active</span>' : '<span class="pill unpaid">Deactivated</span>'}</td>
        <td data-label="Modules"><div class="mods">${d.modules.map((m) => toggle(r, m)).join('')}</div></td>
        <td class="num" data-label="Members">${r.members}</td>
        <td class="acts nowrap"><button class="btn sm" data-view="${r.id}">${ic('users', 15)} Members</button>
          <button class="btn sm" data-act="${r.id}">${r.active ? 'Deactivate' : 'Activate'}</button>
          <button class="ibtn tact bad" data-del="${r.id}" title="Delete organisation" aria-label="Delete ${esc(r.name)}">${ic('trash', 16)}</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty card">No organisations yet.</div>'}`;
  const reload = () => viewOrgControl(el);
  const row = (id) => d.rows.find((r) => r.id === +id);
  $$('[data-mod]', el).forEach((cb) => (cb.onchange = guard(async () => {
    const r = row(cb.dataset.org), mods = $$(`[data-org="${r.id}"]`, el).filter((x) => x.checked).map((x) => x.dataset.mod);
    try { await api('/management/organisations/' + r.id, { method: 'PUT', body: { modules: mods } }); toast(`${r.name}: modules updated`); }
    catch (e) { cb.checked = !cb.checked; throw e; }
    r.modules = mods;
  })));
  $$('[data-act]', el).forEach((b) => (b.onclick = guard(async () => {
    const r = row(b.dataset.act);
    if (r.active && !(await confirmBox(`Deactivate ${r.name}? Its members won't be able to use the app until you activate it again. No data is deleted.`, { ok: 'Deactivate' }))) return;
    await api('/management/organisations/' + r.id, { method: 'PUT', body: { active: !r.active } });
    toast(`${r.name} ${r.active ? 'deactivated' : 'activated'}`); reload();
  })));
  $$('[data-del]', el).forEach((b) => (b.onclick = () => {
    const r = row(b.dataset.del);
    const m = modal(`<h2>Delete ${esc(r.name)}?</h2><p class="muted">This permanently deletes the organisation and all its invoices, payments, clients, tasks and settings. Member accounts are kept but lose access. This cannot be undone.</p>
      <form><div class="field"><label>Type <b>${esc(r.name)}</b> to confirm</label><input name="c" autocomplete="off" required></div>
      <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn danger" disabled>Delete organisation</button></div></form>`);
    const f = $('form', m.el), go = $('.btn.danger', m.el);
    f.c.oninput = () => (go.disabled = f.c.value.trim().toLowerCase() !== r.name.trim().toLowerCase());
    $('[data-x]', m.el).onclick = m.close;
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      await api('/management/organisations/' + r.id, { method: 'DELETE', body: { confirm: f.c.value } });
      m.close(); toast(`${r.name} deleted`); reload();
    });
    f.c.focus();
  }));
  $$('[data-view]', el).forEach((b) => (b.onclick = guard(() => orgDetails(+b.dataset.view, d.modules))));
}
async function orgDetails(id, modules) {
  const d = await api('/management/organisations/' + id), o = d.organisation;
  const active = d.members.filter((u) => u.status === 'approved');
  const m = modal(`<div class="od">
    <div class="row sp"><div><h2>${esc(o.name)}</h2><div class="small muted">Created ${fmtLong(o.created_at)}${o.creator ? ` by ${esc(o.creator.name)} (${esc(o.creator.email)})` : ''}</div></div>
      ${o.active ? '<span class="pill paid">Active</span>' : '<span class="pill unpaid">Deactivated</span>'}</div>
    <div class="od-mods">${modules.map((x) => `<span class="pill ${o.modules.includes(x.id) ? 'paid' : 'unpaid'}">${esc(x.label)} ${o.modules.includes(x.id) ? 'on' : 'off'}</span>`).join('')}
      <span class="small muted">Invite code <code>${esc(o.invite_code)}</code>${o.gst_number ? ` · GSTIN ${esc(o.gst_number)}` : ''}${o.state ? ` · ${esc(o.state)}` : ''}</span></div>
    <h3>Members <span class="muted">(${active.length} active${d.members.length > active.length ? `, ${d.members.length - active.length} other` : ''})</span></h3>
    <div class="card tablewrap" style="padding:0"><table class="od-table"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead><tbody>
      ${d.members.map((u) => `<tr><td><div class="tperson">${avatar(u.name, 'xs')}<span>${esc(u.name)}<div class="small muted">${esc(u.email)}</div></span></div></td>
        <td>${u.role === 'admin' ? 'Admin' : esc(u.user_type || 'Member')}</td><td><span class="pill ${u.status === 'approved' ? (u.active ? 'paid' : 'unpaid') : u.status === 'pending' ? 'partial' : 'unpaid'}">${u.status === 'approved' ? (u.active ? 'Active' : 'Disabled') : esc(u.status)}</span></td>
        <td class="nowrap">${fmtLong(u.decided_at || u.created_at)}</td></tr>`).join('')}</tbody></table></div>
    <div class="actions"><button class="btn" data-x>Close</button></div></div>`);
  m.el.classList.add('wide');
  $('[data-x]', m.el).onclick = m.close;
}

/* ------------------------------------------------------------ organisation signup, join & approval */
const sessionGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sessionSet = (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const pwProblem = (pw) => (pw.length < 8 ? 'Password must be at least 8 characters' : !/[A-Za-z]/.test(pw) || !/\d/.test(pw) ? 'Password must include at least one letter and one number' : '');

// Submit handler with inline error, loading label and double-submit protection.
function submitter(form, fn) {
  let busy = false;
  return async (e) => {
    e && e.preventDefault();
    if (busy) return;
    const btn = $('button.primary', form), err = $('.ob-err', form), label = btn?.innerHTML;
    busy = true; if (btn) { btn.disabled = true; btn.innerHTML = 'Please wait…'; }
    if (err) err.classList.add('hidden');
    try { await fn(); }
    catch (x) { if (err && err.isConnected) { err.textContent = x.message; err.classList.remove('hidden'); } else toast(x.message, true); }
    finally { busy = false; if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
  };
}
const steps = (n) => `<div class="ob-steps" aria-label="Step ${n} of 4">${['Account', 'Organisation', 'Bank', 'Code'].map((s, i) => `<span class="${i + 1 < n ? 'done' : i + 1 === n ? 'on' : ''}">${s}</span>`).join('')}</div>`;
const signInAs = async (token) => { S.token = token; localStorage.setItem('token', token); S.user = (await api('/me')).user; };

function renderOffline() {
  authShell(`<div class="auth-card"><h1>Can't connect</h1><p class="lead">We couldn't reach the server. Check your connection.</p>
    <div class="stack"><button class="btn primary" id="rt">Try again</button><button class="btn" id="so2">Sign out</button></div></div>`);
  $('#rt').onclick = () => boot();
  $('#so2').onclick = () => signOut();
}

function renderSignup() {
  authShell(`<div class="auth-card">
      <h1>Create your account</h1><p class="lead">How would you like to get started?</p>
      <div class="ob-choices">
        <button type="button" class="ob-choice" data-go="create"><span class="ob-ic">${ic('plus', 20)}</span><span><b>Create a new organisation</b><small>Set up invoicing for your business. You'll be its admin.</small></span>${ic('chevron', 18)}</button>
        <button type="button" class="ob-choice" data-go="join"><span class="ob-ic">${ic('users', 20)}</span><span><b>Join an existing organisation</b><small>Use the code your admin shared with you.</small></span>${ic('chevron', 18)}</button>
      </div>
      <p class="ob-alt">Already have an account? <a href="#" data-go="login">Sign in</a></p>
    </div>`);
}

function renderCreateAccount() {
  authShell(`<form class="auth-card" id="ca" novalidate>${steps(1)}
      <h1>Your account</h1><p class="lead">You'll be the admin of your new organisation.</p>
      <div class="stack">
        <div class="field"><label for="nm">Your name</label><div class="inwrap">${ic('user', 18)}<input id="nm" autocomplete="name" placeholder="Full name" maxlength="80" required></div></div>
        ${emailField()}
        ${pwField('pw', 'Password', 'new-password', 'At least 8 characters, with a number')}
        ${pwField('pw2', 'Confirm password', 'new-password', 'Type it again')}
        <div class="ob-err hidden" role="alert"></div>
        <button class="btn primary">Create account</button>
        <p class="ob-alt"><a href="#" data-go="signup">← Back</a> · Have an account? <a href="#" data-go="login">Sign in</a></p>
      </div></form>`);
  $('#ca').onsubmit = submitter($('#ca'), async () => {
    const name = $('#nm').value.trim(), email = $('#em').value.trim(), pw = $('#pw').value;
    if (!name) throw new Error('Enter your name');
    if (!EMAIL_RE.test(email)) throw new Error('Enter a valid email address');
    if (pwProblem(pw)) throw new Error(pwProblem(pw));
    if (pw !== $('#pw2').value) throw new Error('Passwords do not match');
    const r = await api('/signup', { method: 'POST', body: { name, email, password: pw, confirm: $('#pw2').value } });
    await signInAs(r.token);
    sessionSet('onb', 'org');
    await resumeSetup();
  });
}

// Steps 2–4 for a new admin; survives a page refresh through sessionStorage.
async function resumeSetup() {
  S.meta = S.meta || (await api('/meta'));
  const step = sessionGet('onb');
  if (step === 'bank') return renderBankStep();
  if (step === 'code') return showInviteCode();
  return renderOrgStep();
}
const primaryOrg = () => [...S.meta.organisations].sort((a, b) => a.id - b.id)[0];

function renderOrgStep() {
  const o = primaryOrg() || {};
  const placeholderName = /'s organisation$/.test(o.name || '');
  const f = (k, l, extra = '') => `<div class="field"><label for="o_${k}">${l}</label><input id="o_${k}" name="${k}" value="${esc(k === 'name' && placeholderName ? '' : o[k] || '')}" ${extra}></div>`;
  authShell(`<form class="auth-card wide" id="os" novalidate>${steps(2)}
      <h1>Invoicing Organisation</h1><p class="lead">These details print on your invoices. You can change them any time in Settings.</p>
      <div class="grid g2">
        <div class="full">${f('name', 'Organisation / business name', 'maxlength="160" placeholder="Acme Services Pvt Ltd"')}</div>
        ${f('gst_number', 'GSTIN', 'maxlength="15" placeholder="06AABCA1234F1Z5"')}${f('pan_number', 'PAN', 'maxlength="10" placeholder="AABCA1234F"')}
        ${f('email', 'Billing email', 'type="email" placeholder="billing@company.com"')}${f('contact', 'Phone', 'inputmode="tel" placeholder="+91 98765 43210"')}
        <div class="field full"><label for="o_address">Address</label><textarea id="o_address" name="address" rows="2">${esc(o.address || '')}</textarea></div>
        <div class="field full"><label for="o_state">State</label><select id="o_state" name="state_code"><option value="">—</option>${STATE_OPTS().map((s) => `<option value="${s.v}" ${s.v === o.state_code ? 'selected' : ''}>${esc(s.l)}</option>`).join('')}</select></div>
      </div>
      <div class="ob-err hidden" role="alert"></div>
      <div class="ob-actions"><button type="button" class="btn" id="skip">Skip for now</button><button class="btn primary">Save &amp; continue</button></div>
    </form>`);
  const form = $('#os');
  gstHelper(form);
  $('#skip').onclick = () => { sessionSet('onb', 'bank'); toast('Organisation details skipped — add them later in Settings'); renderBankStep(); };
  form.onsubmit = submitter(form, async () => {
    const body = Object.fromEntries(['name', 'gst_number', 'pan_number', 'email', 'contact', 'address', 'state_code'].map((k) => [k, form.elements[k].value.trim()]));
    if (!body.name) throw new Error('Enter your organisation name, or skip this step');
    if (body.gst_number && !gstInfo(body.gst_number).code) throw new Error('GSTIN should be 15 characters, like 06AABCA1234F1Z5');
    if (body.email && !EMAIL_RE.test(body.email)) throw new Error('Enter a valid billing email');
    await api('/organisations/' + o.id, { method: 'PUT', body });
    S.meta.organisations = await api('/organisations');
    sessionSet('onb', 'bank');
    renderBankStep();
  });
}

// Shared bank form (signup step 3 and Settings / dashboard later)
function bankFields(b = {}) {
  const f = (k, l, extra = '') => `<div class="field"><label for="b_${k}">${l}</label><input id="b_${k}" name="${k}" value="${esc(b[k] || '')}" ${extra}></div>`;
  return `<div class="grid g2">${f('account_name', 'Account holder name', 'maxlength="120" autocomplete="off"')}${f('bank_name', 'Bank name', 'maxlength="120" placeholder="HDFC Bank"')}
    ${f('account_number', 'Account number', `inputmode="numeric" maxlength="18" autocomplete="off" placeholder="${b.account_masked ? esc(b.account_masked) + ' (leave blank to keep)' : '6–18 digits'}"`)}${f('ifsc', 'IFSC code', 'maxlength="11" placeholder="HDFC0001234" style="text-transform:uppercase"')}
    ${f('branch', 'Branch (optional)', 'maxlength="120"')}${f('upi_id', 'UPI ID (optional)', 'maxlength="100" placeholder="yourname@bank"')}</div>`;
}
function readBank(form, hasSaved) {
  const v = Object.fromEntries(['account_name', 'bank_name', 'account_number', 'ifsc', 'branch', 'upi_id'].map((k) => [k, form.elements[k].value.trim()]));
  v.ifsc = v.ifsc.toUpperCase(); v.account_number = v.account_number.replace(/\s/g, '');
  if (!v.account_name) throw new Error('Enter the account holder name');
  if (!v.bank_name) throw new Error('Enter the bank name');
  if (!(hasSaved && !v.account_number) && !/^\d{6,18}$/.test(v.account_number)) throw new Error('Account number should be 6–18 digits');
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.ifsc)) throw new Error('IFSC code looks like HDFC0001234 (11 characters)');
  if (v.upi_id && !/^[\w.-]{2,256}@[A-Za-z]\w{1,63}$/.test(v.upi_id)) throw new Error('UPI ID looks like yourname@bank');
  return v;
}

async function renderBankStep() {
  const o = primaryOrg();
  const saved = await api(`/organisations/${o.id}/bank`).catch(() => ({}));
  authShell(`<form class="auth-card wide" id="bs" novalidate>${steps(3)}
      <h1>Bank Details</h1><p class="lead">Printed on invoices so clients can pay you. Optional — you can add these later.</p>
      ${bankFields(saved)}
      <div class="ob-err hidden" role="alert"></div>
      <div class="ob-actions"><button type="button" class="btn" id="skip">Skip for now</button><button class="btn primary">Save &amp; continue</button></div>
    </form>`);
  const form = $('#bs');
  $('#skip').onclick = () => { sessionSet('onb', 'code'); toast('Bank details skipped — add them later in Settings'); showInviteCode(); };
  form.onsubmit = submitter(form, async () => {
    await api(`/organisations/${o.id}/bank`, { method: 'PUT', body: readBank(form, !!saved.account_masked) });
    S.meta.organisations = await api('/organisations');
    sessionSet('onb', 'code');
    showInviteCode();
  });
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  if (btn) { const h = btn.innerHTML; btn.innerHTML = `${ic('check', 16)} Copied`; btn.classList.add('ok'); setTimeout(() => { if (btn.isConnected) { btn.innerHTML = h; btn.classList.remove('ok'); } }, 1800); }
  toast('Code copied');
}
const codeBox = (code) => `<div class="ob-code"><code id="ivc">${esc(code)}</code><button type="button" class="btn sm" data-copy>${ic('copy', 16)} Copy code</button></div>`;

async function showInviteCode() {
  const t = await api('/organisation');
  authShell(`<div class="auth-card">${steps(4)}<h1>You're all set</h1><p class="lead">${esc(t.name)} is ready.</p></div>`);
  const finish = () => { sessionSet('onb', null); location.hash = '#/dashboard'; boot(); };
  const m = modal(`<div class="ob-done"><span class="ob-badge">${ic('check', 26)}</span><h2>Organisation created</h2>
      <p class="muted">Share this code with your team. They can use it to request to join <b>${esc(t.name)}</b>, and you approve each request from your dashboard.</p>
      ${codeBox(t.invite_code)}
      ${!t.setup.details || !t.setup.bank ? `<p class="small muted">You skipped ${[!t.setup.details && 'organisation details', !t.setup.bank && 'bank details'].filter(Boolean).join(' and ')}. You can add them from the dashboard or Settings.</p>` : ''}
      <button class="btn primary" id="cont">Continue to dashboard</button></div>`, { onClose: finish });
  $('[data-copy]', m.el).onclick = (e) => copyText(t.invite_code, e.currentTarget);
  $('#cont', m.el).onclick = () => m.close();
}

function renderJoin() {
  let confirmed = null; // organisation name once the code has been checked
  authShell(`<form class="auth-card" id="jf" novalidate>
      <h1>Join an organisation</h1><p class="lead">Sign in with your account, or choose a password to create one.</p>
      <div class="stack">
        ${emailField()}
        ${pwField('pw', 'Password', 'current-password', 'Your password (new accounts: 8+ chars, with a number)')}
        <div class="field"><label for="cd">Organisation code</label><div class="inwrap">${ic('link', 18)}<input id="cd" placeholder="ABCDE-23456" maxlength="11" autocomplete="off" autocapitalize="characters" spellcheck="false" required></div></div>
        <div class="ob-confirm hidden" id="oc"></div>
        <div class="ob-err hidden" role="alert"></div>
        <button class="btn primary" id="jb">Find organisation</button>
        <p class="ob-alt"><a href="#" data-go="signup">← Back</a> · Have an account? <a href="#" data-go="login">Sign in</a></p>
      </div></form>`);
  const form = $('#jf');
  $('#cd').oninput = () => { if (confirmed) { confirmed = null; $('#oc').classList.add('hidden'); $('#jb').textContent = 'Find organisation'; } };
  form.onsubmit = submitter(form, async () => {
    const email = $('#em').value.trim(), pw = $('#pw').value, code = $('#cd').value.trim();
    if (!EMAIL_RE.test(email)) throw new Error('Enter a valid email address');
    if (!pw) throw new Error('Enter your password');
    if (!code) throw new Error('Enter the organisation code');
    if (!confirmed) {
      confirmed = (await api('/join/lookup', { method: 'POST', body: { code } })).organisation;
      $('#oc').innerHTML = `<span>${ic('users', 18)}</span><div>You're asking to join <b>${esc(confirmed)}</b>. An admin will review your request.</div>`;
      $('#oc').classList.remove('hidden');
      setTimeout(() => { const b = $('#jb'); if (b) b.textContent = 'Send join request'; }, 0);
      return;
    }
    const r = await api('/join', { method: 'POST', body: { email, password: pw, code } });
    await signInAs(r.token);
    boot();
  });
}

// Signed in, but not (yet) an approved member: waiting / declined / no organisation.
let pollTimer;
function renderMembership() {
  clearTimeout(pollTimer);
  const m = S.user.membership, st = m?.status;
  const who = `<p class="small muted ob-who">Signed in as ${esc(S.user.email)} · <a href="#" id="so2">Sign out</a></p>`;
  if (st === 'pending') {
    authShell(`<div class="auth-card ob-wait"><span class="ob-badge wait">${ic('clock', 26)}</span>
        <h1>Request sent</h1><p class="lead">Your request to join <b>${esc(m.organisation)}</b> has been submitted. Waiting for admin approval.</p>
        <div class="ob-live"><i></i>We'll take you in automatically once you're approved. You can also close this page and sign in later.</div>
        <div class="stack"><button class="btn" id="ck">Check now</button><button class="btn" id="cx">Cancel request</button></div>${who}</div>`);
    const check = async (manual) => {
      try {
        S.user = (await api('/me')).user;
        if (S.user.membership?.status === 'approved') { toast(`Welcome to ${S.user.membership.organisation}!`); location.hash = '#/dashboard'; return boot(); }
        if (S.user.membership?.status !== 'pending') return renderMembership();
        if (manual) toast('Still waiting for approval');
      } catch (e) { if (manual) toast(e.message, true); }
      if ($('.ob-wait')) pollTimer = setTimeout(() => check(false), 5000);
    };
    pollTimer = setTimeout(() => check(false), 5000);
    $('#ck').onclick = () => { clearTimeout(pollTimer); check(true); };
    $('#cx').onclick = guard(async () => {
      if (!(await confirmBox('Cancel your request to join this organisation?'))) return;
      await api('/membership/cancel', { method: 'POST' }); S.user.membership = null; renderMembership();
    });
  } else if (st === 'deactivated') {
    authShell(`<div class="auth-card"><span class="ob-badge bad">${ic('lock', 26)}</span><h1>Organisation deactivated</h1>
        <p class="lead"><b>${esc(m.organisation)}</b> has been deactivated by the platform team, so the app isn't available right now. Your data is safe; contact support or your organisation admin to get it reactivated.</p>
        <div class="stack"><button class="btn" id="ck">Check again</button></div>${who}</div>`);
    $('#ck').onclick = guard(async () => { S.user = (await api('/me')).user; if (S.user.membership?.status === 'approved') boot(); else toast('Still deactivated', true); });
  } else {
    const declined = st === 'rejected';
    authShell(`<form class="auth-card" id="mf" novalidate>
        ${declined ? `<span class="ob-badge bad">${ic('x', 26)}</span><h1>Request declined</h1><p class="lead">${esc(m.organisation)} didn't approve your request. You can join a different organisation or create your own.</p>`
          : '<h1>Choose an organisation</h1><p class="lead">Your account isn\'t part of an organisation yet.</p>'}
        <div class="stack">
          <div class="field"><label for="cd">Organisation code</label><div class="inwrap">${ic('link', 18)}<input id="cd" placeholder="ABCDE-23456" maxlength="11" autocomplete="off" spellcheck="false"></div></div>
          <div class="ob-err hidden" role="alert"></div>
          <button class="btn primary">Request to join</button>
          <button type="button" class="btn" id="mk">Create my own organisation</button>
        </div>${who}</form>`);
    const form = $('#mf');
    form.onsubmit = submitter(form, async () => {
      const code = $('#cd').value.trim();
      if (!code) throw new Error('Enter the organisation code');
      const { organisation } = await api('/join/lookup', { method: 'POST', body: { code } });
      if (!(await confirmBox(`Send a request to join ${organisation}?`))) return;
      await api('/membership/request', { method: 'POST', body: { code } });
      boot();
    });
    $('#mk').onclick = guard(async () => {
      await api('/onboarding/organisation', { method: 'POST' });
      S.user = (await api('/me')).user; S.meta = null;
      sessionSet('onb', 'org'); resumeSetup();
    });
  }
  $('#so2').onclick = (e) => { e.preventDefault(); clearTimeout(pollTimer); api('/logout', { method: 'POST' }).catch(() => {}); signOut(); };
}

// Dashboard: pending membership requests + unfinished setup (admins only)
async function adminPanel(box) {
  const [reqs, t, roles] = await Promise.all([api('/members/requests'), api('/organisation'), api('/roles')]).catch((e) => { box.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return []; });
  if (!t) return;
  const opts = roles.map((r) => `<option value="${r.id}" ${r.name === 'Team member' ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const todo = [!t.setup.details && `<button class="btn sm" data-fix="org">${ic('edit', 15)} Add organisation details</button>`, !t.setup.bank && `<button class="btn sm" data-fix="bank">${ic('wallet', 15)} Add bank details</button>`].filter(Boolean);
  box.innerHTML = `${todo.length ? `<section class="card ob-setup"><div><h2>Finish setting up</h2><p class="small muted">These were skipped during signup. They appear on your invoices.</p></div><div class="row">${todo.join('')}</div></section>` : ''}
    <section class="card req-card"><div class="row sp"><h2>Pending requests${reqs.length ? ` <span class="badge">${reqs.length}</span>` : ''}</h2>
      <button class="btn sm" data-showcode>${ic('link', 15)} Invite code</button></div>
      ${reqs.length ? `<div class="mrows">${reqs.map((r) => `<div class="mr-i req" data-r="${r.id}">${avatar(r.name, 'sm')}<div class="mid"><div class="t">${esc(r.name)}</div><div class="s">${esc(r.email)} · requested ${fmtLong(r.created_at)}</div></div>
          <div class="end req-acts"><select aria-label="User type for ${esc(r.name)}">${opts}</select><button class="btn sm danger" data-rej>Reject</button><button class="btn sm primary" data-ok>Approve</button></div></div>`).join('')}</div>`
        : '<div class="empty">No pending requests. Share your invite code so teammates can ask to join.</div>'}</section>`;
  const act = (b, kind) => guard(async () => {
    const row = b.closest('[data-r]'), name = $('.t', row).textContent;
    if (kind === 'reject' && !(await confirmBox(`Reject ${name}'s request?`))) return;
    $$('button', row).forEach((x) => (x.disabled = true));
    try {
      await api(`/members/requests/${row.dataset.r}/${kind}`, { method: 'POST', body: kind === 'approve' ? { role_id: +$('select', row).value } : {} });
      toast(kind === 'approve' ? `${name} can now access the organisation` : 'Request rejected');
    } finally { adminPanel(box); }
  });
  $$('[data-ok]', box).forEach((b) => (b.onclick = act(b, 'approve')));
  $$('[data-rej]', box).forEach((b) => (b.onclick = act(b, 'reject')));
  $('[data-showcode]', box).onclick = () => { const m = modal(`<h2>Invite code</h2><p class="muted">People can use this code to request to join ${esc(t.name)}.</p>${codeBox(t.invite_code)}<div class="actions"><button class="btn" data-x>Close</button></div>`); $('[data-copy]', m.el).onclick = (e) => copyText(t.invite_code, e.currentTarget); $('[data-x]', m.el).onclick = m.close; };
  const fix = $('[data-fix=org]', box), fixB = $('[data-fix=bank]', box), org = primaryOrg();
  if (fix) fix.onclick = () => crudForm(CFG.organisations, org, () => adminPanel(box));
  if (fixB) fixB.onclick = () => bankModal(org, () => adminPanel(box));
}
async function bankModal(org, done) {
  const saved = await api(`/organisations/${org.id}/bank`);
  const m = modal(`<h2>Bank details · ${esc(org.name)}</h2><form novalidate>${bankFields(saved)}<div class="ob-err hidden" role="alert"></div><div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`);
  const form = $('form', m.el);
  $('[data-x]', m.el).onclick = m.close;
  form.onsubmit = submitter(form, async () => {
    await api(`/organisations/${org.id}/bank`, { method: 'PUT', body: readBank(form, !!saved.account_masked) });
    S.meta.organisations = await api('/organisations');
    m.close(); toast('Bank details saved'); done && done();
  });
}
async function inviteCard(box) {
  const t = await api('/organisation');
  box.innerHTML = `<div class="card"><h2>Organisation invite code</h2><p class="small muted">Anyone with this code can <b>request</b> to join ${esc(t.name)} — you approve each request on the dashboard. Regenerate it to stop the old code working.</p>
    ${codeBox(t.invite_code)}<div class="row" style="margin-top:10px"><button class="btn sm" id="rg">Regenerate code</button>${primaryOrg() ? `<button class="btn sm" id="bk">${ic('wallet', 15)} Bank details</button>` : ''}</div></div>`;
  $('[data-copy]', box).onclick = (e) => copyText(t.invite_code, e.currentTarget);
  $('#rg', box).onclick = guard(async () => { if (!(await confirmBox('Make a new code? The current code will stop working.'))) return; await api('/organisation/invite-code', { method: 'POST' }); toast('New code created'); inviteCard(box); });
  if ($('#bk', box)) $('#bk', box).onclick = () => bankModal(primaryOrg(), () => viewSettings($('#view')));
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js').catch(() => {});
const pubMatch = location.pathname.match(/^\/p\/([\w-]+)/);
if (pubMatch) publicView(pubMatch[1]); else boot();
