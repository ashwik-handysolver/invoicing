// Modules an organisation can be given by platform management. Each module owns a set of permission groups;
// Settings, users, roles and the activity log belong to every organisation regardless of modules.
export const MODULES = {
  invoicing: { label: 'Invoicing', perms: ['dashboard', 'invoices', 'payments', 'clients', 'products', 'reminders', 'recurring', 'expenses', 'gst', 'templates'] },
  tasks: { label: 'Task management', perms: ['tasks'] },
};
export const ALL_MODULES = Object.keys(MODULES);

// tenants.modules is a JSON array; NULL (organisations created before modules existed) means everything.
export const tenantModules = (raw) => {
  try { const m = JSON.parse(raw); return Array.isArray(m) ? m.filter((x) => MODULES[x]) : ALL_MODULES; } catch { return ALL_MODULES; }
};

// Drop permissions that belong to modules the organisation doesn't have. '*' is expanded first so it can be trimmed.
export function permsForModules(perms, modules, allKeys) {
  const off = new Set(ALL_MODULES.filter((m) => !modules.includes(m)).flatMap((m) => MODULES[m].perms));
  if (!off.size) return perms;
  const list = perms.includes('*') ? [...allKeys, ...perms.filter((p) => p !== '*')] : perms;
  return [...new Set(list.filter((k) => !off.has(k.split('.')[0])))];
}
