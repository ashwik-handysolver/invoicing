# Invocing

Proforma & Tax invoices, RBAC, manual WhatsApp/Email sending with templates, payment reminders,
revenue tracker with CSV export. Mobile-first UI.

## Run
```
npm install
npm start          # http://localhost:3000
```
Needs Node 22.5+ (uses built-in `node:sqlite`; data in `invoice.db`). First run seeds demo data:
login `admin@example.com` / `admin123` — change it under Settings.

## Notes
- Numbering: `INV/FY26-27/PI|TI/0001`, per organisation + type + financial year.
- GST: CGST+SGST when org and client state (GSTIN prefix) match, else IGST. TDS is % of taxable value.
- Proforma → "Convert to tax invoice" copies items; payments are recorded on tax invoices only.
- Roles/permissions are `module.action` keys (see `PERMISSIONS` in `server/index.js`), editable at Roles.
- WhatsApp/Email are manual: buttons open `wa.me` / `mailto:` with the rendered template; CC emails from Settings are added.
- Schema mirrors your MySQL reference (clients, invoice, invoice items, CC emails) trimmed to what's used.
