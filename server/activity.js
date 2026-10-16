import { run } from './db.js';

// One line per meaningful change; user may be null for automated actions.
export const logAct = (user, action, entity, entityId, summary) =>
  run('INSERT INTO activity_log (user_id, user_name, action, entity, entity_id, summary) VALUES (?,?,?,?,?,?)',
    user?.id ?? null, user?.name ?? 'System (auto)', action, entity, entityId ?? null, summary ?? null);
