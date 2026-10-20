import { db, all, get, run, tx, getSetting, setSetting } from './db.js';
import { logAct } from './activity.js';

/* ------------------------------------------------ task management */
export const TASK_PRIORITIES = ['high', 'medium', 'low'];
export const TASK_STATUSES = ['todo', 'in_progress', 'done'];
export const TASK_PERMS = ['tasks.view', 'tasks.create', 'tasks.edit', 'tasks.delete'];

db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'todo',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL, -- legacy single assignee; task_assignees is the source of truth
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
-- a task can be assigned to several people
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);`);
// one-time: copy the old single assignee into task_assignees
if (!getSetting('tasks_multi_assignees', false)) {
  run('INSERT OR IGNORE INTO task_assignees (task_id, user_id) SELECT id, assigned_to FROM tasks WHERE assigned_to IS NOT NULL');
  setSetting('tasks_multi_assignees', true);
}

// Team members of existing organisations get the task permissions once (Admin already has '*').
export function ensureTaskPerms() {
  if (getSetting('perms_tasks_v1', false)) return;
  for (const r of all("SELECT id, permissions FROM roles WHERE name = 'Team member'")) {
    const p = JSON.parse(r.permissions);
    if (!p.includes('*')) run('UPDATE roles SET permissions = ? WHERE id = ?', JSON.stringify([...new Set([...p, ...TASK_PERMS])]), r.id);
  }
  setSetting('perms_tasks_v1', true);
}

const ASSIGNED_TO = (uidParam = '?') => `EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ${uidParam})`;
// Which tasks a user can see: admins see every task in the organisation, everyone else only the tasks
// they created or that are assigned to them. Use on any query over `tasks t`.
export const taskScope = (u) => (u.isAdmin ? { sql: '1', params: [] } : { sql: `(t.assigned_by = ? OR ${ASSIGNED_TO()})`, params: [u.id, u.id] });
export const assignedToSql = ASSIGNED_TO;
export const isAssignee = (taskId, uid) => !!get('SELECT 1 AS x FROM task_assignees WHERE task_id = ? AND user_id = ?', taskId, uid);
// attach `assignees: [{ id, name }]` to task rows
export function withAssignees(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return rows;
  const by = {};
  for (const a of all(`SELECT a.task_id, u.id, u.name FROM task_assignees a JOIN users u ON u.id = a.user_id
    WHERE a.task_id IN (${list.map(() => '?').join(',')}) ORDER BY u.name`, ...list.map((r) => r.id))) (by[a.task_id] ||= []).push({ id: a.id, name: a.name });
  for (const r of list) { r.assignees = by[r.id] || []; delete r.assigned_to; }
  return rows;
}
export const setAssignees = (taskId, ids) => {
  run('DELETE FROM task_assignees WHERE task_id = ?', taskId);
  for (const id of ids) run('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)', taskId, id);
};

// People a user may assign tasks to: approved, active members; team members cannot assign to admins.
const PEOPLE_SQL = `SELECT u.id, u.name FROM users u JOIN memberships m ON m.user_id = u.id
  WHERE m.tenant_id = ? AND m.status = 'approved' AND u.active = 1`;
export const assignablePeople = (u, extra = '', ...p) => all(`${PEOPLE_SQL} ${u.isAdmin ? '' : "AND m.role != 'admin'"} ${extra} ORDER BY u.name`, u.tid, ...p);
export const assignable = (u, uid) => !!get(`${PEOPLE_SQL} AND u.id = ? ${u.isAdmin ? '' : "AND m.role != 'admin'"}`, u.tid, uid);
// Validate a list of assignee ids for this user (unique, assignable); throws on the first bad one
export function checkAssignees(u, ids, fail) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter((x) => x !== null && x !== '' && x !== undefined).map(Number))];
  for (const id of list) if (!assignable(u, id)) throw fail(u.isAdmin ? 400 : 403, u.isAdmin ? 'An assignee is not in this organisation' : 'You can only assign tasks to team members, not admins');
  return list;
}

export function registerTasks({ api, need, wrap, fail }) {
  const row = `SELECT t.*, ub.name AS assigned_by_name FROM tasks t LEFT JOIN users ub ON ub.id = t.assigned_by`;
  const one = (req) => { const v = taskScope(req.user); return get(`${row} WHERE t.id = ? AND t.tenant_id = ? AND ${v.sql}`, req.params.id, req.user.tid, ...v.params) || (() => { throw fail(404, 'Not found'); })(); };
  // body -> task fields; `assignees` (array of user ids) replaces the assignee list. A single `assigned_to` is still accepted.
  const pick = (req) => {
    const b = req.body || {}, o = {};
    for (const k of ['title', 'description', 'due_date']) if (b[k] !== undefined) o[k] = typeof b[k] === 'string' ? b[k].trim() || null : b[k];
    if (b.priority !== undefined) { if (!TASK_PRIORITIES.includes(b.priority)) throw fail(400, 'Priority must be high, medium or low'); o.priority = b.priority; }
    if (b.status !== undefined) { if (!TASK_STATUSES.includes(b.status)) throw fail(400, 'Invalid status'); o.status = b.status; }
    const raw = b.assignees !== undefined ? b.assignees : b.assigned_to !== undefined ? (b.assigned_to ? [b.assigned_to] : []) : undefined;
    return { o, assignees: raw === undefined ? undefined : checkAssignees(req.user, raw, fail) };
  };

  // people tasks can be assigned to
  api.get('/tasks/people', need('tasks.view'), wrap((req) => assignablePeople(req.user)));
  api.get('/tasks', need('tasks.view'), wrap((req) => { const v = taskScope(req.user); return withAssignees(all(`${row} WHERE t.tenant_id = ? AND ${v.sql}
    ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END, t.due_date IS NULL, t.due_date, CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id DESC`, req.user.tid, ...v.params)); }));
  api.post('/tasks', need('tasks.create'), wrap((req) => {
    const { o, assignees } = pick(req);
    if (!o.title) throw fail(400, 'Title is required');
    o.assigned_by = req.user.id;
    const keys = Object.keys(o);
    const id = tx(() => {
      const tid = run(`INSERT INTO tasks (tenant_id, ${keys.join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`, req.user.tid, ...keys.map((k) => o[k])).lastInsertRowid;
      setAssignees(tid, assignees || []);
      return tid;
    });
    logAct(req.user, 'create', 'tasks', id, o.title);
    req.params.id = id;
    return withAssignees(one(req));
  }));
  // The assigner (and org admins) may change everything; an assignee may only move the status.
  const canManage = (req, t) => req.user.isAdmin || t.assigned_by === req.user.id;
  api.put('/tasks/:id', need('tasks.view'), wrap((req) => {
    const old = one(req), { o, assignees } = pick(req);
    if (!canManage(req, old)) {
      if (!isAssignee(old.id, req.user.id)) throw fail(403, 'Only the person who assigned this task can change it');
      if (Object.keys(o).some((k) => k !== 'status') || assignees !== undefined) throw fail(403, 'You can only update the status of a task assigned to you');
    }
    if ('title' in o && !o.title) throw fail(400, 'Title is required');
    const keys = Object.keys(o);
    tx(() => {
      if (keys.length) run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ? AND tenant_id = ?`, ...keys.map((k) => o[k]), old.id, req.user.tid);
      if (assignees !== undefined) setAssignees(old.id, assignees);
    });
    logAct(req.user, 'update', 'tasks', old.id, o.title || old.title);
    return withAssignees(one(req));
  }));
  api.delete('/tasks/:id', need('tasks.delete'), wrap((req) => {
    const old = one(req);
    if (!canManage(req, old)) throw fail(403, 'Only the person who assigned this task can delete it');
    run('DELETE FROM tasks WHERE id = ? AND tenant_id = ?', old.id, req.user.tid);
    logAct(req.user, 'delete', 'tasks', old.id, old.title);
    return { ok: true };
  }));
}
