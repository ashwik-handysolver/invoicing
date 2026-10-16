import { run } from './db.js';

// One line per meaningful change; user may be null for automated actions (then pass the tenant explicitly).
export const logAct = (user, action, entity, entityId, summary, tid = user?.tid) =>
  run('INSERT INTO activity_log (tenant_id, user_id, user_name, action, entity, entity_id, summary) VALUES (?,?,?,?,?,?,?)',
    tid ?? null, user?.id ?? null, user?.name ?? 'System (auto)', action, entity, entityId ?? null, summary ?? null);
