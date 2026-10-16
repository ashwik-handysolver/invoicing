export const r2 = (n) => Math.round((+n || 0) * 100) / 100;

export const STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
  '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

// GSTIN prefix wins; otherwise fall back to the stored state_code.
export function stateCode(party) {
  const g = (party?.gst_number || '').trim();
  if (/^\d{2}/.test(g)) return g.slice(0, 2);
  return party?.state_code || '';
}

export function calcInvoice({ items, intra, tdsPercent }) {
  const t = { gross: 0, disc: 0, sell: 0, igst: 0, cgst: 0, sgst: 0, total: 0 };
  const out = items.map((it, i) => {
    const price = +it.price || 0, qty = +it.quantity || 0;
    const dp = +it.discount_percent || 0, tax = +it.tax || 0;
    const gross = r2(price * qty), disc = r2((gross * dp) / 100), sell = r2(gross - disc);
    const taxAmt = r2((sell * tax) / 100);
    const cgst = intra ? r2(taxAmt / 2) : 0;
    const sgst = intra ? r2(taxAmt - cgst) : 0;
    const igst = intra ? 0 : taxAmt;
    const total = r2(sell + taxAmt);
    t.gross += gross; t.disc += disc; t.sell += sell; t.igst += igst; t.cgst += cgst; t.sgst += sgst; t.total += total;
    return {
      service_product_id: it.service_product_id || null, position: i + 1,
      sac_number: it.sac_number || '', description: it.description || '',
      price, quantity: qty, gross_amount: gross, discount_percent: dp, discount_amount: disc,
      selling_amount: sell, tax, igst, cgst, sgst, total_amount: total,
    };
  });
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  const tdsAmount = r2((t.sell * (+tdsPercent || 0)) / 100);
  return { items: out, totals: { ...t, tds_amount: tdsAmount, net: r2(t.total - tdsAmount) } };
}

export function financialYear(dateStr) {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const start = m >= 3 ? y : y - 1;
  return `FY${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

export function paymentStatus(net, paid) {
  if (paid >= net - 0.005 && net > 0) return 'paid';
  return paid > 0 ? 'partial' : 'unpaid';
}
