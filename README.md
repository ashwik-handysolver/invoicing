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

## Configuration
Settings and keys go in a `.env` file in the project root (copy `.env.example`). It is git-ignored and loaded automatically on start; variables set in the shell override it. Restart the server after editing it.

## Organisations
- Sign up from the login screen: **Create a new organisation** (you become its admin; organisation and bank details can be skipped) or **Join an existing organisation** with the invite code the admin shares.
- Join requests stay *pending* with no access until an admin approves them on the dashboard ("Pending requests"). Admins can copy or regenerate the code in Settings.
- All data (clients, invoices, roles, templates, settings…) is scoped to one organisation. Existing single-company databases are migrated automatically into organisation #1 on first start.
- `SEED_DEMO=0` skips the demo organisation on a brand-new database.

## Voice assistant
- Tap the mic (sidebar, or centre of the mobile tab bar) and speak in Hindi, English or Hinglish, or type. Examples: "Tata Motors ka status inactive kar do", "How much is overdue?", "ZOHO ka payment UPI se full aa gaya", "invoices kholo".
- Needs an AI key on the server: `GEMINI_API_KEY` (free tier from aistudio.google.com; `GOOGLE_API_KEY` also works; default model `gemini-3.5-flash`, falling back to `gemini-flash-latest` / `gemini-flash-lite-latest` when one is busy) or `ANTHROPIC_API_KEY` (default `claude-opus-5-5`). If both are set Claude is used; force one with `VOICE_PROVIDER=gemini|claude`, override the model with `VOICE_MODEL`. Speech recognition uses the browser (Chrome / Edge); other browsers can type.
- It can search clients/invoices, give a money summary, open pages, update a client (incl. status Active / Inactive / On hold), add a client and record a payment. Every change is shown as a card and only saved after you confirm (tap, or say "haan" / "yes"). Actions run with your own permissions inside your organisation and are logged in Activity as "(voice)".

## Notes
- Numbering: `INV/FY26-27/PI|TI/0001`, per organisation + type + financial year.
- GST: CGST+SGST when org and client state (GSTIN prefix) match, else IGST. TDS is % of taxable value.
- Proforma → "Convert to tax invoice" copies items; payments are recorded on tax invoices only.
- User types: each organisation has exactly two, **Admin** (everything) and **Team member** (day-to-day invoicing, payments, clients, reminders, expenses, GST; no deleting, users or settings). Admins pick the type when approving a request or under Users. **Management** accounts are separate: platform staff who manage the software, not members of any organisation.
- WhatsApp/Email are manual: buttons open `wa.me` / `mailto:` with the rendered template; CC emails from Settings are added.
- Schema mirrors your MySQL reference (clients, invoice, invoice items, CC emails) trimmed to what's used.
