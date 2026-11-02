// Web push notifications (works with the app closed; on iPhone once the app is added to the home screen).
// VAPID keys: from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, else generated once and kept in settings (tenant 0).
import webpush from 'web-push';
import { all, get, run } from './db.js';

let ready = null;
function vapid() {
  return (ready ||= (async () => {
    let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) {
      const g = webpush.generateVAPIDKeys();
      // first server instance to get here stores its keys; everyone uses the stored pair
      await run("INSERT INTO settings (tenant_id, key, value) VALUES (0, 'vapid_keys', ?) ON CONFLICT (tenant_id, key) DO NOTHING", JSON.stringify(g));
      ({ publicKey: pub, privateKey: priv } = JSON.parse((await get("SELECT value FROM settings WHERE tenant_id = 0 AND key = 'vapid_keys'")).value));
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@invocing.app', pub, priv);
    return pub;
  })().catch((e) => { ready = null; throw e; }));
}

// Send { title, body, url, tag } to every device of these users. Never throws: a failed push must not fail the action.
export async function notify(userIds, payload) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return 0;
  try {
    await vapid();
    const subs = await all(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`, ...ids);
    const res = await Promise.allSettled(subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(payload), { TTL: 24 * 3600, urgency: 'normal', timeout: 8000 })));
    let sent = 0;
    for (const [i, r] of res.entries()) {
      if (r.status === 'fulfilled') { sent++; continue; }
      if ([404, 410].includes(r.reason?.statusCode)) await run('DELETE FROM push_subscriptions WHERE id = ?', subs[i].id); // device unsubscribed
      else console.error('push failed', r.reason?.statusCode || '', r.reason?.message);
    }
    return sent;
  } catch (e) { console.error('push error', e.message); return 0; }
}

// approved admins of an organisation
export const tenantAdmins = async (tid) => (await all("SELECT user_id FROM memberships WHERE tenant_id = ? AND status = 'approved' AND role = 'admin'", tid)).map((r) => r.user_id);

const inr = (n) => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// Once a day: invoices overdue / due today (for people who handle reminders) and the person's own tasks due.
export async function dailyDigest({ force = false } = {}) {
  const day = istToday();
  if (!force && (await get("SELECT 1 AS x FROM settings WHERE tenant_id = 0 AND key = 'push_digest_date' AND value = ?", JSON.stringify(day)))) return 0;
  await run("INSERT INTO settings (tenant_id, key, value) VALUES (0, 'push_digest_date', ?) ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value", JSON.stringify(day));
  // open tasks past their due date are overdue (same rule as tasks.js markOverdue; not imported to avoid a module cycle)
  await run("UPDATE tasks SET status = 'overdue' WHERE status IN ('assigned', 'in_progress') AND due_date IS NOT NULL AND due_date < ?", day);
  const people = await all(`SELECT DISTINCT m.user_id, m.tenant_id, m.role, r.permissions FROM push_subscriptions s
      JOIN memberships m ON m.user_id = s.user_id AND m.status = 'approved' JOIN tenants t ON t.id = m.tenant_id AND t.active = 1
      LEFT JOIN roles r ON r.id = m.role_id`);
  let sent = 0;
  for (const p of people) {
    const perms = JSON.parse(p.permissions || '[]'), canRemind = perms.includes('*') || perms.includes('reminders.view');
    const parts = [];
    if (canRemind) {
      const inv = await get(`SELECT COUNT(*) FILTER (WHERE due_date < ?) AS overdue, COALESCE(SUM(balance_amount) FILTER (WHERE due_date < ?), 0) AS overdue_amt,
          COUNT(*) FILTER (WHERE due_date = ?) AS today FROM invoices WHERE tenant_id = ? AND invoice_type = 'tax' AND balance_amount > 0.005`, day, day, day, p.tenant_id);
      if (inv.overdue) parts.push(`${inv.overdue} invoice${inv.overdue === 1 ? '' : 's'} overdue (${inr(inv.overdue_amt)})`);
      if (inv.today) parts.push(`${inv.today} due today`);
    }
    const tasks = (await get(`SELECT COUNT(*) AS n FROM tasks t WHERE t.tenant_id = ? AND t.status IN ('assigned', 'in_progress', 'overdue') AND t.due_date <= ?
        AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ?)`, p.tenant_id, day, p.user_id)).n;
    if (tasks) parts.push(`${tasks} task${tasks === 1 ? '' : 's'} due`);
    if (!parts.length) continue;
    sent += await notify([p.user_id], { title: 'Today in Invoice Manager', body: parts.join(' · '), url: canRemind ? '/#/reminders' : '/#/tasks', tag: 'daily-digest' });
  }
  return sent;
}

export function registerPush({ base, wrap, fail }) {
  base.get('/push/key', wrap(async () => ({ publicKey: await vapid() })));
  base.post('/push/subscribe', wrap(async (req) => {
    const s = req.body?.subscription || {};
    if (!/^https:\/\//.test(s.endpoint || '') || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') throw fail(400, 'Invalid push subscription');
    // one row per device; signing in as someone else on the same browser moves the device to them
    await run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      req.user.id, s.endpoint.slice(0, 1000), s.keys.p256dh.slice(0, 200), s.keys.auth.slice(0, 100), String(req.headers['user-agent'] || '').slice(0, 200));
    return { ok: true };
  }));
  base.post('/push/unsubscribe', wrap(async (req) => {
    await run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), req.user.id);
    return { ok: true };
  }));
  base.post('/push/test', wrap(async (req) => ({ sent: await notify([req.user.id], { title: 'Notifications are on', body: "You'll be notified about new tasks, join requests and money due.", url: '/#/dashboard', tag: 'test' }) })));
}
