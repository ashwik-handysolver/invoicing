const svg64 = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
// Placeholder branding so a fresh install already prints a complete-looking invoice.
export const DUMMY_COMPANY = {
  name: 'Acme Digital Services Pvt Ltd',
  address: 'Plot 21, Sector 44, Gurugram, Haryana, 122003',
  state: 'Haryana', state_code: '06', gst_number: '06AABCA1234F1Z5', pan_number: 'AABCA1234F',
  email: 'billing@acmedigital.example', contact: '+91 98765 43210',
  bank_details: 'Bank Name: HDFC Bank\nAccount Name: Acme Digital Services Pvt Ltd\nA/c Number: 50200012345678\nIFSC Code: HDFC0001234\nBranch: Sector 44, Gurugram\nSWIFT Code: HDFCINBB',
  upi_id: 'acmedigital@hdfcbank',
  terms: '1. Payment is due within the number of days shown on the invoice.\n2. Late payments attract interest at 2% per month.\n3. Work continues only against cleared payments.\n4. All disputes are subject to Gurugram jurisdiction.',
  footer_note: 'Thank you for your business!',
  logo: svg64('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80"><rect width="64" height="64" x="4" y="8" rx="16" fill="#1f4fd8"/><path d="M22 52V28l10-8 10 8v24h-7V36h-6v16z" fill="#fff"/><text x="80" y="38" font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="700" fill="#141a2e">ACME</text><text x="80" y="60" font-family="Arial,Helvetica,sans-serif" font-size="15" letter-spacing="3" fill="#6a7184">DIGITAL SERVICES</text></svg>'),
  signature: svg64('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="90" viewBox="0 0 240 90"><text x="10" y="55" font-family="cursive,\'Brush Script MT\',\'Segoe Script\'" font-size="38" fill="#1f2a6b">A. Sharma</text><path d="M10 68 Q80 58 200 66" stroke="#1f2a6b" stroke-width="2" fill="none"/></svg>'),
};
