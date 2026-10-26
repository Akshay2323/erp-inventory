/**
 * Reports. GST reports use the transaction-time details stored on each voucher (party GSTIN, state,
 * place of supply, tax treatment), never the current master data.
 */
const pool = require('../../config/db');
const { httpError, today, parseDate, cleanText } = require('../common');
const { assertCompanyUsable } = require('../party/access');
const { loadVersions, resolveVersion } = require('../versioning');
const { SIDES, LEDGER_GROUPS, B2CL_LIMIT } = require('../../config/accountingConfig');
const { GST_STATE_CODES } = require('../taxValidation');
const { requireBooks, fyBounds } = require('./books');
const { resolveMapping } = require('./ledgers');
const { openAmountSql, partyGroup, loadPartyForCtx } = require('./vouchers');
const { LIVE_ENTRY_SQL } = require('./posting');
const { r2, requireCompanyId, withTransaction } = require('./common');

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

async function companyParam(ctx, query) {
  const companyId = requireCompanyId(query.company_id);
  await assertCompanyUsable(ctx, companyId);
  return companyId;
}

async function periodParams(companyId, query) {
  const books = await requireBooks(pool, companyId);
  const month = cleanText(query.month);
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw httpError(400, 'month must be YYYY-MM');
    const from = `${month}-01`;
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return { from, to: d.toISOString().slice(0, 10), books };
  }
  const to = parseDate(query.to, 'to') || today();
  const from = parseDate(query.from, 'from') || fyBounds(to, books.fy_start_month).start;
  if (from > to) throw httpError(400, 'from must be on or before to');
  return { from, to, books };
}

// ---------- bill-wise (sales / purchases) ----------

async function openItems(side, companyId, { partyIds = null, asOf }) {
  const open = openAmountSql(side, 'v', asOf);
  const params = [...open.params, companyId, asOf];
  let sql = `SELECT v.id, v.voucher_type, v.voucher_no, v.voucher_date, v.due_date, v.reference_no, v.${side.partyFk},
                    v.party_code, v.party_name, v.total_amount, v.party_effect, ${open.sql} AS open_amount
             FROM ${side.table} v
             WHERE v.company_id = ? AND v.status = 'POSTED' AND v.voucher_date <= ?`;
  if (partyIds) { sql += ` AND v.${side.partyFk} IN (?)`; params.push(partyIds); }
  const [rows] = await pool.query(`${sql} HAVING open_amount > 0.004 ORDER BY COALESCE(v.due_date, v.voucher_date), v.id`, params);
  return rows.map((r) => {
    const due = r.due_date || r.voucher_date;
    return {
      ...r,
      total_amount: Number(r.total_amount),
      open_amount: r2(r.open_amount),
      kind: r.party_effect === side.receivableEffect ? 'BILL' : 'ADVANCE_OR_CREDIT',
      days_from_bill: daysBetween(r.voucher_date, asOf),
      days_overdue: Math.max(0, daysBetween(due, asOf)),
    };
  });
}

async function partyFilter(side, query) {
  const id = cleanText(query[side.partyFk]);
  return id ? partyGroup(pool, side, Number(id)) : null;
}

async function outstanding(ctx, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const items = await openItems(side, companyId, { partyIds: await partyFilter(side, query), asOf });
  const bills = items.filter((i) => i.kind === 'BILL');
  const credits = items.filter((i) => i.kind !== 'BILL');
  const sum = (list) => r2(list.reduce((s, i) => s + i.open_amount, 0));
  return {
    as_of: asOf,
    bills,
    advances_and_credits: credits,
    totals: {
      [side.key === 'sales' ? 'receivable' : 'payable']: sum(bills),
      overdue: sum(bills.filter((b) => b.days_overdue > 0)),
      advances_and_credits: sum(credits),
      net: r2(sum(bills) - sum(credits)),
    },
  };
}

/** Party GL balance (DR - CR) from live entries up to a date. */
async function partyLedgerBalances(side, companyId, asOf) {
  const [rows] = await pool.query(
    `SELECT e.party_id, SUM(e.debit - e.credit) AS balance FROM ledger_entries e
     WHERE e.company_id = ? AND e.party_type = ? AND e.entry_date <= ? AND ${LIVE_ENTRY_SQL}
     GROUP BY e.party_id`,
    [companyId, side.partyType, asOf]
  );
  return new Map(rows.map((r) => [r.party_id, r2(r.balance)]));
}

/** Client-wise receivables / vendor-wise payables. */
async function partySummary(ctx, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const items = await openItems(side, companyId, { partyIds: await partyFilter(side, query), asOf });
  const gl = await partyLedgerBalances(side, companyId, asOf);
  const sign = side.receivableEffect === 'DR' ? 1 : -1;
  const byParty = new Map();
  for (const i of items) {
    const id = i[side.partyFk];
    if (!byParty.has(id)) byParty.set(id, { [side.partyFk]: id, code: i.party_code, name: i.party_name, outstanding: 0, overdue: 0, advance: 0, bills: 0, oldest_due: null });
    const p = byParty.get(id);
    if (i.kind === 'BILL') {
      p.outstanding = r2(p.outstanding + i.open_amount);
      p.bills += 1;
      if (i.days_overdue > 0) p.overdue = r2(p.overdue + i.open_amount);
      const due = i.due_date || i.voucher_date;
      if (!p.oldest_due || due < p.oldest_due) p.oldest_due = due;
    } else p.advance = r2(p.advance + i.open_amount);
  }
  let limits = new Map();
  if (side.key === 'sales' && byParty.size) {
    const [rows] = await pool.query(
      `SELECT f.client_id, f.credit_limit FROM client_financial_settings f
       WHERE f.client_id IN (?) AND f.effective_from = (SELECT MAX(x.effective_from) FROM client_financial_settings x
         WHERE x.client_id = f.client_id AND x.effective_from <= ?)`,
      [[...byParty.keys()], asOf]
    );
    limits = new Map(rows.map((r) => [r.client_id, Number(r.credit_limit)]));
  }
  const data = [...byParty.values()].map((p) => {
    const net = r2(p.outstanding - p.advance);
    const ledger = r2((gl.get(p[side.partyFk]) || 0) * sign);
    return {
      ...p,
      net,
      ...(side.key === 'sales' ? { credit_limit: limits.get(p[side.partyFk]) || 0, credit_available: limits.get(p[side.partyFk]) ? r2(limits.get(p[side.partyFk]) - net) : null } : {}),
      ledger_balance: ledger,
      reconciled: r2(ledger - net) === 0,
    };
  }).sort((a, b) => b.net - a.net);
  const total = (f) => r2(data.reduce((s, p) => s + p[f], 0));
  return {
    as_of: asOf,
    data,
    totals: { outstanding: total('outstanding'), overdue: total('overdue'), advance: total('advance'), net: total('net') },
  };
}

async function ageing(ctx, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const basis = (cleanText(query.basis) || 'DUE_DATE').toUpperCase();
  if (!['DUE_DATE', 'BILL_DATE'].includes(basis)) throw httpError(400, 'basis must be DUE_DATE or BILL_DATE');
  const limits = (cleanText(query.buckets) || '30,60,90,180').split(',').map((x) => Number(x.trim()));
  if (limits.some((n) => !Number.isInteger(n) || n <= 0) || limits.some((n, i) => i && n <= limits[i - 1])) {
    throw httpError(400, 'buckets must be increasing whole numbers, e.g. 30,60,90');
  }
  const labels = [...limits.map((n, i) => `${i ? limits[i - 1] + 1 : 0}-${n}`), `${limits[limits.length - 1]}+`];
  const items = await openItems(side, companyId, { partyIds: await partyFilter(side, query), asOf });
  const byParty = new Map();
  const empty = () => ({ not_due: 0, ...Object.fromEntries(labels.map((l) => [l, 0])), total: 0, unadjusted_advance: 0, net: 0 });
  for (const i of items) {
    const id = i[side.partyFk];
    if (!byParty.has(id)) byParty.set(id, { [side.partyFk]: id, code: i.party_code, name: i.party_name, ...empty() });
    const p = byParty.get(id);
    if (i.kind !== 'BILL') { p.unadjusted_advance = r2(p.unadjusted_advance + i.open_amount); continue; }
    const age = basis === 'DUE_DATE' ? daysBetween(i.due_date || i.voucher_date, asOf) : i.days_from_bill;
    let bucket;
    if (basis === 'DUE_DATE' && age <= 0) bucket = 'not_due';
    else {
      const idx = limits.findIndex((n) => Math.max(age, 0) <= n);
      bucket = labels[idx === -1 ? labels.length - 1 : idx];
    }
    p[bucket] = r2(p[bucket] + i.open_amount);
    p.total = r2(p.total + i.open_amount);
  }
  const data = [...byParty.values()].map((p) => ({ ...p, net: r2(p.total - p.unadjusted_advance) })).sort((a, b) => b.total - a.total);
  const totals = empty();
  for (const p of data) for (const k of Object.keys(totals)) totals[k] = r2(totals[k] + p[k]);
  return { as_of: asOf, basis, buckets: ['not_due', ...labels], data, totals };
}

/** Party ledger statement (includes records merged into the party). */
async function statement(ctx, partyId, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const party = await loadPartyForCtx(pool, side, ctx, partyId);
  const { from, to } = await periodParams(party.company_id, query);
  const ids = await partyGroup(pool, side, party.id);
  const [[opening]] = await pool.query(
    `SELECT COALESCE(SUM(e.debit - e.credit), 0) AS balance FROM ledger_entries e
     WHERE e.party_type = ? AND e.party_id IN (?) AND (e.entry_date < ? OR e.voucher_type = 'OPENING_BALANCE') AND ${LIVE_ENTRY_SQL}`,
    [side.partyType, ids, from]
  );
  const [rows] = await pool.query(
    `SELECT e.entry_date, e.voucher_id, e.voucher_type, e.voucher_no, e.debit, e.credit, v.reference_no, v.narration, v.due_date
     FROM ledger_entries e JOIN ${side.table} v ON v.id = e.voucher_id
     WHERE e.source = ? AND e.party_type = ? AND e.party_id IN (?) AND e.entry_date BETWEEN ? AND ?
       AND e.voucher_type <> 'OPENING_BALANCE' AND ${LIVE_ENTRY_SQL}
     ORDER BY e.entry_date, e.id`,
    [side.source, side.partyType, ids, from, to]
  );
  let balance = r2(opening.balance);
  const bal = (b) => ({ balance: Math.abs(b), balance_type: b >= 0 ? 'DR' : 'CR' });
  const lines = rows.map((r) => {
    balance = r2(balance + Number(r.debit) - Number(r.credit));
    return { ...r, debit: Number(r.debit), credit: Number(r.credit), ...bal(balance) };
  });
  const sum = (f) => r2(lines.reduce((s, l) => s + l[f], 0));
  return {
    [side.partyFk]: party.id,
    code: party.code,
    includes_merged: ids.slice(1),
    from,
    to,
    opening: bal(r2(opening.balance)),
    lines,
    totals: { debit: sum('debit'), credit: sum('credit') },
    closing: bal(balance),
    open_items: await openItems(side, party.company_id, { partyIds: ids, asOf: to }),
  };
}

/** Sales / purchase register summary by voucher type and month. */
async function register(ctx, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const { from, to } = await periodParams(companyId, query);
  const [rows] = await pool.query(
    `SELECT voucher_type, DATE_FORMAT(voucher_date, '%Y-%m') AS month, status, COUNT(*) AS count,
            SUM(taxable_value) AS taxable_value, SUM(cgst_amount) AS cgst, SUM(sgst_amount) AS sgst,
            SUM(igst_amount) AS igst, SUM(cess_amount) AS cess, SUM(total_amount) AS total
     FROM ${side.table} WHERE company_id = ? AND voucher_date BETWEEN ? AND ? AND voucher_type <> 'OPENING_BALANCE'
     GROUP BY voucher_type, month, status ORDER BY month, voucher_type`,
    [companyId, from, to]
  );
  const amounts = ['taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'total'];
  return {
    from, to,
    data: rows.map((r) => ({ ...r, count: Number(r.count), ...Object.fromEntries(amounts.map((a) => [a, r2(r[a])])) })),
  };
}

// ---------- GST reports ----------

async function gstVouchers(side, companyId, from, to, types) {
  const [vouchers] = await pool.query(
    `SELECT * FROM ${side.table} WHERE company_id = ? AND voucher_date BETWEEN ? AND ? AND voucher_type IN (?) ORDER BY voucher_date, id`,
    [companyId, from, to, types]
  );
  if (!vouchers.length) return [];
  const [lines] = await pool.query(`SELECT * FROM ${side.linesTable} WHERE voucher_id IN (?) ORDER BY line_no`, [vouchers.map((v) => v.id)]);
  const byVoucher = new Map();
  for (const l of lines) {
    if (!byVoucher.has(l.voucher_id)) byVoucher.set(l.voucher_id, []);
    byVoucher.get(l.voucher_id).push(l);
  }
  return vouchers.map((v) => ({ ...v, lines: byVoucher.get(v.id) || [] }));
}

const TAX_FIELDS = ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount'];
function addAmounts(target, src, sign = 1) {
  for (const f of TAX_FIELDS) target[f] = r2((target[f] || 0) + sign * Number(src[f] || 0));
  return target;
}
function rateWise(lines) {
  const m = new Map();
  for (const l of lines) {
    const k = Number(l.gst_rate);
    if (!m.has(k)) m.set(k, { gst_rate: k });
    addAmounts(m.get(k), l);
  }
  return [...m.values()];
}
const NIL_TREATMENTS = ['EXEMPT', 'NIL_RATED', 'NON_GST'];
const INVOICE_TYPES = ['SALES_INVOICE', 'PURCHASE_INVOICE'];
function isNilLine(v, l) {
  return NIL_TREATMENTS.includes(v.tax_treatment) || (Number(l.gst_rate) === 0 && v.tax_treatment === 'TAXABLE');
}
function docSummary(vouchers) {
  const m = new Map();
  for (const v of vouchers) {
    const k = `${v.voucher_type}|${v.series_id}`;
    if (!m.has(k)) m.set(k, { voucher_type: v.voucher_type, series_id: v.series_id, from_no: v.voucher_no, to_no: v.voucher_no, total: 0, cancelled: 0 });
    const d = m.get(k);
    d.total += 1;
    if (v.status === 'CANCELLED') d.cancelled += 1;
    if (v.voucher_no < d.from_no) d.from_no = v.voucher_no;
    if (v.voucher_no > d.to_no) d.to_no = v.voucher_no;
  }
  return [...m.values()].map((d) => ({ ...d, net_issued: d.total - d.cancelled }));
}
function hsnSummary(vouchers, sectionOf) {
  const m = new Map();
  for (const v of vouchers) {
    if (v.status !== 'POSTED') continue;
    const s = INVOICE_TYPES.includes(v.voucher_type) ? 1 : -1;
    for (const l of v.lines) {
      const k = `${sectionOf(v)}|${l.hsn_sac || 'NA'}|${Number(l.gst_rate)}|${l.unit || 'OTH'}`;
      if (!m.has(k)) m.set(k, { section: sectionOf(v), hsn_sac: l.hsn_sac || null, gst_rate: Number(l.gst_rate), unit: l.unit || 'OTH', qty: 0, total_value: 0 });
      const h = m.get(k);
      h.qty = Math.round((h.qty + s * Number(l.qty)) * 1000) / 1000;
      h.total_value = r2(h.total_value + s * Number(l.line_total));
      addAmounts(h, l, s);
    }
  }
  return [...m.values()].sort((a, b) => String(a.hsn_sac).localeCompare(String(b.hsn_sac)) || a.gst_rate - b.gst_rate);
}
function invoiceRow(v) {
  return {
    voucher_id: v.id, voucher_type: v.voucher_type, voucher_no: v.voucher_no, voucher_date: v.voucher_date,
    party_name: v.party_name, party_gstin: v.party_gstin, place_of_supply: v.place_of_supply,
    place_of_supply_name: GST_STATE_CODES[v.place_of_supply] || null, supply_type: v.supply_type,
    tax_treatment: v.tax_treatment, reverse_charge: !!v.reverse_charge, reference_no: v.reference_no, reference_date: v.reference_date,
    invoice_value: Number(v.total_amount), rates: rateWise(v.lines.filter((l) => !isNilLine(v, l))),
  };
}

async function salesGstReport(side, companyId, from, to) {
  const all = await gstVouchers(side, companyId, from, to, ['SALES_INVOICE', 'SALES_RETURN', 'CREDIT_NOTE']);
  const posted = all.filter((v) => v.status === 'POSTED');
  const sections = { b2b: [], b2cl: [], exp: [], cdnr: [], cdnur: [] };
  const b2cs = new Map();
  const nil = new Map();
  const isExport = (v) => v.party_registration_type === 'OVERSEAS' || String(v.tax_treatment).startsWith('EXPORT');
  const sectionOf = (v) => (v.party_gstin ? 'B2B' : 'B2C');

  for (const v of posted) {
    const note = v.voucher_type !== 'SALES_INVOICE';
    const taxLines = v.lines.filter((l) => !isNilLine(v, l));
    for (const l of v.lines.filter((x) => isNilLine(v, x))) {
      const k = `${v.supply_type}|${v.party_gstin ? 'REGISTERED' : 'UNREGISTERED'}|${NIL_TREATMENTS.includes(v.tax_treatment) ? v.tax_treatment : 'NIL_RATED'}`;
      if (!nil.has(k)) nil.set(k, { supply_type: v.supply_type, recipient: v.party_gstin ? 'REGISTERED' : 'UNREGISTERED', category: k.split('|')[2], value: 0 });
      nil.get(k).value = r2(nil.get(k).value + (note ? -1 : 1) * Number(l.taxable_value));
    }
    if (!taxLines.length) continue;
    const row = invoiceRow(v);
    if (note) {
      row.note_type = 'C';
      if (v.party_gstin) sections.cdnr.push(row);
      else if (isExport(v) || (v.supply_type === 'INTER' && Number(v.total_amount) > B2CL_LIMIT)) sections.cdnur.push(row);
      else for (const r of row.rates) {
        const k = `${v.place_of_supply}|${r.gst_rate}`;
        if (!b2cs.has(k)) b2cs.set(k, { place_of_supply: v.place_of_supply, supply_type: v.supply_type, gst_rate: r.gst_rate });
        addAmounts(b2cs.get(k), r, -1);
      }
      continue;
    }
    if (v.party_gstin) sections.b2b.push(row);
    else if (isExport(v)) sections.exp.push(row);
    else if (v.supply_type === 'INTER' && Number(v.total_amount) > B2CL_LIMIT) sections.b2cl.push(row);
    else for (const r of row.rates) {
      const k = `${v.place_of_supply}|${r.gst_rate}`;
      if (!b2cs.has(k)) b2cs.set(k, { place_of_supply: v.place_of_supply, supply_type: v.supply_type, gst_rate: r.gst_rate });
      addAmounts(b2cs.get(k), r);
    }
  }

  const total = (list, sign = 1) => list.reduce((acc, row) => {
    for (const r of row.rates || [row]) addAmounts(acc, r, sign);
    return acc;
  }, {});
  const outward = addAmounts(addAmounts(addAmounts(addAmounts({}, total(sections.b2b)), total(sections.b2cl)), total(sections.exp)), total([...b2cs.values()]));
  addAmounts(outward, total(sections.cdnr), -1);
  addAmounts(outward, total(sections.cdnur), -1);
  return {
    gstr1: {
      b2b: sections.b2b, b2cl: sections.b2cl, b2cs: [...b2cs.values()], exp: sections.exp,
      cdnr: sections.cdnr, cdnur: sections.cdnur, nil_exempt: [...nil.values()],
      hsn: hsnSummary(posted, sectionOf),
      documents_issued: docSummary(all),
    },
    summary: {
      net_outward_taxable_supplies: outward,
      total_tax: r2(outward.cgst_amount + outward.sgst_amount + outward.igst_amount + outward.cess_amount),
      invoices: posted.filter((v) => v.voucher_type === 'SALES_INVOICE').length,
      notes: posted.filter((v) => v.voucher_type !== 'SALES_INVOICE').length,
      cancelled: all.length - posted.length,
    },
  };
}

async function purchaseGstReport(side, companyId, from, to) {
  const all = await gstVouchers(side, companyId, from, to, ['PURCHASE_INVOICE', 'PURCHASE_RETURN', 'DEBIT_NOTE']);
  const posted = all.filter((v) => v.status === 'POSTED');
  const b2b = new Map();
  const rcm = [];
  const notes = [];
  const others = new Map();
  const itc = { eligible: {}, ineligible: {}, reversed_on_notes: {}, rcm_liability: {} };

  for (const v of posted) {
    const sign = v.voucher_type === 'PURCHASE_INVOICE' ? 1 : -1;
    const row = invoiceRow(v);
    const eligibleLines = v.lines.filter((l) => l.itc_eligible);
    const ineligibleLines = v.lines.filter((l) => !l.itc_eligible);
    row.itc_eligible = addAmounts({}, eligibleLines.reduce((a, l) => addAmounts(a, l), {}));
    if (v.reverse_charge) {
      rcm.push(row);
      addAmounts(itc.rcm_liability, v, sign);
    }
    if (sign === 1) {
      for (const l of eligibleLines) addAmounts(itc.eligible, l);
      for (const l of ineligibleLines) addAmounts(itc.ineligible, l);
    } else {
      for (const l of eligibleLines) addAmounts(itc.reversed_on_notes, l);
      notes.push({ ...row, note_type: 'D' });
      continue;
    }
    if (v.reverse_charge) continue;
    if (v.party_gstin) {
      if (!b2b.has(v.party_gstin)) b2b.set(v.party_gstin, { supplier_gstin: v.party_gstin, supplier_name: v.party_name, invoices: [], totals: {} });
      const s = b2b.get(v.party_gstin);
      s.invoices.push(row);
      addAmounts(s.totals, v);
    } else {
      const k = v.party_registration_type || 'UNREGISTERED';
      if (!others.has(k)) others.set(k, { registration_type: k, count: 0, value: 0 });
      others.get(k).count += 1;
      others.get(k).value = r2(others.get(k).value + Number(v.total_amount));
    }
  }
  const net = {};
  addAmounts(net, itc.eligible);
  addAmounts(net, itc.reversed_on_notes, -1);
  return {
    b2b: [...b2b.values()],
    reverse_charge: rcm,
    debit_notes_and_returns: notes,
    unregistered_composition_imports: [...others.values()],
    hsn: hsnSummary(posted, (v) => (v.party_gstin ? 'B2B' : 'OTHER')),
    itc_summary: {
      eligible_itc: itc.eligible,
      reversed_on_returns_and_debit_notes: itc.reversed_on_notes,
      net_eligible_itc: net,
      ineligible_itc: itc.ineligible,
      reverse_charge_liability: itc.rcm_liability,
    },
    documents: docSummary(all),
  };
}

async function gstReport(ctx, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const { from, to } = await periodParams(companyId, query);
  const report = side.key === 'sales' ? await salesGstReport(side, companyId, from, to) : await purchaseGstReport(side, companyId, from, to);
  return { company_id: companyId, from, to, basis: 'Transaction-time GSTIN / state / place of supply stored on each voucher', ...report };
}

async function pendingEwayBills(ctx, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const { from, to } = await periodParams(companyId, query);
  const types = Object.keys(side.voucherTypes).filter((t) => side.voucherTypes[t].eway);
  const [rows] = await pool.query(
    `SELECT v.id, v.voucher_type, v.voucher_no, v.voucher_date, v.party_name, v.total_amount, s.eway_bill_threshold
     FROM ${side.table} v
     JOIN company_accounting_settings s ON s.company_id = v.company_id AND v.voucher_date >= s.effective_from
       AND (s.effective_to IS NULL OR v.voucher_date <= s.effective_to)
     WHERE v.company_id = ? AND v.status = 'POSTED' AND v.voucher_type IN (?) AND v.voucher_date BETWEEN ? AND ?
       AND v.total_amount > s.eway_bill_threshold
       AND EXISTS (SELECT 1 FROM ${side.linesTable} l WHERE l.voucher_id = v.id AND (l.hsn_sac IS NULL OR l.hsn_sac NOT LIKE '99%'))
       AND NOT EXISTS (SELECT 1 FROM ${side.ewayTable} e WHERE e.voucher_id = v.id AND e.status = 'ACTIVE')
     ORDER BY v.voucher_date`,
    [companyId, types, from, to]
  );
  return rows.map((r) => ({ ...r, total_amount: Number(r.total_amount), eway_bill_threshold: Number(r.eway_bill_threshold) }));
}

// ---------- company books (accounting) ----------

async function ledgerNames(companyId, asOf) {
  const [ledgers] = await pool.query('SELECT * FROM ledgers WHERE company_id = ? ORDER BY code', [companyId]);
  const versions = await loadVersions(pool, 'ledger_versions', 'ledger_id', ledgers.map((l) => l.id));
  return ledgers.map((l) => {
    const { current, upcoming } = resolveVersion(versions.get(l.id) || [], asOf);
    const v = current || upcoming;
    return { ...l, name: v?.name, ledger_group: v?.ledger_group, nature: LEDGER_GROUPS[v?.ledger_group] };
  });
}

async function trialBalance(ctx, query = {}) {
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const { from, to } = await periodParams(companyId, query);
  const [rows] = await pool.query(
    `SELECT e.ledger_id,
            SUM(CASE WHEN e.entry_date < ? OR e.voucher_type = 'OPENING_BALANCE' THEN e.debit - e.credit ELSE 0 END) AS opening,
            SUM(CASE WHEN e.entry_date BETWEEN ? AND ? AND e.voucher_type <> 'OPENING_BALANCE' THEN e.debit ELSE 0 END) AS debit,
            SUM(CASE WHEN e.entry_date BETWEEN ? AND ? AND e.voucher_type <> 'OPENING_BALANCE' THEN e.credit ELSE 0 END) AS credit
     FROM ledger_entries e WHERE e.company_id = ? AND e.entry_date <= ? AND ${LIVE_ENTRY_SQL}
     GROUP BY e.ledger_id`,
    [from, from, to, from, to, companyId, to]
  );
  const moves = new Map(rows.map((r) => [r.ledger_id, r]));
  const bal = (b) => ({ amount: Math.abs(r2(b)), type: b >= 0 ? 'DR' : 'CR' });
  const data = (await ledgerNames(companyId, to)).map((l) => {
    const m = moves.get(l.id) || { opening: 0, debit: 0, credit: 0 };
    const ledgerOpening = (l.opening_type === 'DR' ? 1 : -1) * Number(l.opening_balance);
    const opening = r2(ledgerOpening + Number(m.opening));
    const closing = r2(opening + Number(m.debit) - Number(m.credit));
    return {
      ledger_id: l.id, code: l.code, name: l.name, ledger_group: l.ledger_group, nature: l.nature,
      opening: bal(opening), debit: r2(m.debit), credit: r2(m.credit), closing: bal(closing), _closing: closing, _opening: opening,
    };
  }).filter((x) => x._opening || x.debit || x.credit || x._closing || query.include_zero === 'true');
  const sum = (f) => r2(data.reduce((s, x) => s + f(x), 0));
  const totals = {
    opening_debit: sum((x) => (x._opening > 0 ? x._opening : 0)),
    opening_credit: sum((x) => (x._opening < 0 ? -x._opening : 0)),
    debit: sum((x) => x.debit),
    credit: sum((x) => x.credit),
    closing_debit: sum((x) => (x._closing > 0 ? x._closing : 0)),
    closing_credit: sum((x) => (x._closing < 0 ? -x._closing : 0)),
  };
  totals.difference = r2(totals.closing_debit - totals.closing_credit);
  return { from, to, data: data.map(({ _closing, _opening, ...x }) => x), totals, balanced: totals.difference === 0 };
}

async function ledgerStatement(ctx, ledgerId, query = {}) {
  ctx.assert('view');
  const [[ledger]] = await pool.query('SELECT * FROM ledgers WHERE id = ?', [Number(ledgerId) || 0]);
  if (!ledger || !ctx.canSeeCompany(ledger.company_id)) throw httpError(404, 'Ledger not found');
  const { from, to } = await periodParams(ledger.company_id, query);
  const [[opening]] = await pool.query(
    `SELECT COALESCE(SUM(e.debit - e.credit), 0) AS balance FROM ledger_entries e
     WHERE e.ledger_id = ? AND (e.entry_date < ? OR e.voucher_type = 'OPENING_BALANCE') AND ${LIVE_ENTRY_SQL}`,
    [ledger.id, from]
  );
  const [rows] = await pool.query(
    `SELECT e.entry_date, e.source, e.voucher_id, e.voucher_type, e.voucher_no, e.party_type, e.party_id, e.debit, e.credit, e.narration
     FROM ledger_entries e WHERE e.ledger_id = ? AND e.entry_date BETWEEN ? AND ? AND e.voucher_type <> 'OPENING_BALANCE' AND ${LIVE_ENTRY_SQL}
     ORDER BY e.entry_date, e.id`,
    [ledger.id, from, to]
  );
  let balance = r2((ledger.opening_type === 'DR' ? 1 : -1) * Number(ledger.opening_balance) + Number(opening.balance));
  const bal = (b) => ({ balance: Math.abs(b), balance_type: b >= 0 ? 'DR' : 'CR' });
  const openingBal = bal(balance);
  const lines = rows.map((r) => {
    balance = r2(balance + Number(r.debit) - Number(r.credit));
    return { ...r, debit: Number(r.debit), credit: Number(r.credit), ...bal(balance) };
  });
  return { ledger_id: ledger.id, code: ledger.code, from, to, opening: openingBal, lines, closing: bal(balance) };
}

/** Consistency checks between bill-wise records, the general ledger, control ledgers and master balances. */
async function reconciliation(ctx, query = {}) {
  ctx.assert('view');
  const companyId = await companyParam(ctx, query);
  const asOf = today();
  const checks = [];
  for (const side of Object.values(SIDES)) {
    const label = side.partyCfg.labelPlural;
    const gl = await partyLedgerBalances(side, companyId, '9999-12-31');
    const open = openAmountSql(side);
    const [bills] = await pool.query(
      `SELECT v.${side.partyFk} AS party_id, SUM(CASE WHEN v.party_effect = 'DR' THEN ${open.sql} ELSE -${open.sql} END) AS net
       FROM ${side.table} v WHERE v.company_id = ? AND v.status = 'POSTED' GROUP BY v.${side.partyFk}`,
      [...open.params, ...open.params, companyId]
    );
    const billNet = new Map(bills.map((b) => [b.party_id, r2(b.net)]));
    const [parties] = await pool.query(
      `SELECT id, code, outstanding_balance, advance_balance FROM ${side.partyCfg.table} WHERE company_id = ?`, [companyId]
    );
    const mismatches = [];
    const masterMismatches = [];
    const sign = side.receivableEffect === 'DR' ? 1 : -1;
    for (const p of parties) {
      const g = gl.get(p.id) || 0;
      const b = billNet.get(p.id) || 0;
      if (r2(g - b) !== 0) mismatches.push({ id: p.id, code: p.code, ledger_balance: g, bill_wise_net: b, difference: r2(g - b) });
      const master = r2(Number(p.outstanding_balance) - Number(p.advance_balance));
      if (r2(master - b * sign) !== 0) masterMismatches.push({ id: p.id, code: p.code, master_net: master, bill_wise_net: r2(b * sign) });
    }
    checks.push({ check: `${label}: party ledger = bill-wise outstanding`, ok: !mismatches.length, details: mismatches });
    checks.push({ check: `${label}: master outstanding / advance columns are current`, ok: !masterMismatches.length, details: masterMismatches });

    const [openingRows] = await pool.query(
      `SELECT p.id, p.code,
              (SELECT CASE WHEN f.opening_balance_type = ? THEN f.opening_balance ELSE -f.opening_balance END
               FROM ${side.partyCfg.financialTable} f WHERE f.${side.partyFk} = p.id ORDER BY f.effective_from DESC LIMIT 1) AS master_opening,
              (SELECT COALESCE(SUM(CASE WHEN v.party_effect = ? THEN v.total_amount ELSE -v.total_amount END), 0)
               FROM ${side.table} v WHERE v.${side.partyFk} = p.id AND v.voucher_type = 'OPENING_BALANCE' AND v.status = 'POSTED') AS posted_opening
       FROM ${side.partyCfg.table} p WHERE p.company_id = ? AND p.merged_into_id IS NULL`,
      [side.receivableEffect, side.receivableEffect, companyId]
    );
    const openingIssues = openingRows
      .map((r) => ({ id: r.id, code: r.code, master_opening: r2(r.master_opening || 0), posted_opening_bills: r2(r.posted_opening) }))
      .filter((r) => r.master_opening !== r.posted_opening_bills)
      .map((r) => ({ ...r, fix: `PUT /api/${side.key}/${side.partyPath}/${r.id}/opening-bills` }));
    checks.push({ check: `${label}: opening balance in master = posted opening bills`, ok: !openingIssues.length, details: openingIssues });

    try {
      const control = await resolveMapping(pool, companyId, side.controlKey, asOf);
      const [[c]] = await pool.query(
        `SELECT COALESCE(SUM(e.debit - e.credit), 0) AS balance, COALESCE(SUM(CASE WHEN e.party_id IS NULL THEN e.debit - e.credit ELSE 0 END), 0) AS without_party
         FROM ledger_entries e WHERE e.company_id = ? AND e.ledger_id = ? AND ${LIVE_ENTRY_SQL}`,
        [companyId, control.id]
      );
      const partyTotal = r2([...gl.values()].reduce((s, x) => s + x, 0));
      checks.push({
        check: `${label}: control ledger ${control.code} = sum of party balances`,
        ok: r2(c.balance) === partyTotal && r2(c.without_party) === 0,
        details: { control_balance: r2(c.balance), party_total: partyTotal, entries_without_party: r2(c.without_party) },
      });
    } catch (err) {
      checks.push({ check: `${label}: control ledger`, ok: false, details: err.message });
    }

    const [unbalanced] = await pool.query(
      `SELECT e.voucher_id, e.voucher_no, SUM(e.debit) AS debit, SUM(e.credit) AS credit
       FROM ledger_entries e WHERE e.company_id = ? AND e.source = ? AND ${LIVE_ENTRY_SQL}
       GROUP BY e.voucher_id, e.voucher_no HAVING ROUND(SUM(e.debit) - SUM(e.credit), 2) <> 0`,
      [companyId, side.source]
    );
    const [unposted] = await pool.query(
      `SELECT v.id, v.voucher_no FROM ${side.table} v WHERE v.company_id = ? AND v.status = 'POSTED'
         AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.source = ? AND e.voucher_id = v.id AND e.revision = v.revision AND ${LIVE_ENTRY_SQL})`,
      [companyId, side.source]
    );
    checks.push({ check: `${label}: every posted voucher has balanced ledger entries`, ok: !unbalanced.length && !unposted.length, details: { unbalanced, unposted } });
  }
  const tb = await trialBalance(ctx, { company_id: companyId, to: asOf });
  checks.push({ check: 'Trial balance tallies', ok: tb.balanced, details: tb.totals });
  return { company_id: companyId, checked_at: new Date().toISOString(), ok: checks.every((c) => c.ok), checks };
}

async function refreshBalances(ctx, body = {}) {
  ctx.assert('manage');
  const companyId = await companyParam(ctx, body);
  let count = 0;
  await withTransaction(async (conn) => {
    for (const side of Object.values(SIDES)) {
      const open = openAmountSql(side);
      const [result] = await conn.query(
        `UPDATE ${side.partyCfg.table} p SET
           outstanding_balance = (SELECT COALESCE(SUM(${open.sql}), 0) FROM ${side.table} v
                                  WHERE v.${side.partyFk} = p.id AND v.status = 'POSTED' AND v.party_effect = ?),
           advance_balance = (SELECT COALESCE(SUM(${open.sql}), 0) FROM ${side.table} v
                              WHERE v.${side.partyFk} = p.id AND v.status = 'POSTED' AND v.party_effect <> ?)
         WHERE p.company_id = ?`,
        [side.receivableEffect, side.receivableEffect, companyId]
      );
      count += result.affectedRows;
    }
  });
  return { company_id: companyId, parties_refreshed: count };
}

/** Bank reconciliation: book balance vs balance as per bank (uncleared receipts / payments). */
async function bankReconciliation(ctx, query = {}) {
  ctx.assert('view');
  const [[ledger]] = await pool.query('SELECT * FROM ledgers WHERE id = ?', [Number(query.ledger_id) || 0]);
  if (!ledger || !ctx.canSeeCompany(ledger.company_id)) throw httpError(404, 'ledger_id not found');
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const [[{ balance }]] = await pool.query(
    `SELECT COALESCE(SUM(e.debit - e.credit), 0) AS balance FROM ledger_entries e WHERE e.ledger_id = ? AND e.entry_date <= ? AND ${LIVE_ENTRY_SQL}`,
    [ledger.id, asOf]
  );
  const book = r2((ledger.opening_type === 'DR' ? 1 : -1) * Number(ledger.opening_balance) + Number(balance));
  const uncleared = [];
  for (const side of Object.values(SIDES)) {
    const [rows] = await pool.query(
      `SELECT id, voucher_type, voucher_no, voucher_date, party_name, instrument_no, payment_mode, total_amount, party_effect, bank_cleared_on
       FROM ${side.table} WHERE cash_bank_ledger_id = ? AND status = 'POSTED' AND voucher_date <= ?
         AND (bank_cleared_on IS NULL OR bank_cleared_on > ?) ORDER BY voucher_date`,
      [ledger.id, asOf, asOf]
    );
    for (const r of rows) {
      const bankEffect = r.party_effect === 'CR' ? 'DR' : 'CR';
      uncleared.push({ ...r, side: side.key, total_amount: Number(r.total_amount), bank_effect: bankEffect });
    }
  }
  const deposits = r2(uncleared.filter((u) => u.bank_effect === 'DR').reduce((s, u) => s + u.total_amount, 0));
  const withdrawals = r2(uncleared.filter((u) => u.bank_effect === 'CR').reduce((s, u) => s + u.total_amount, 0));
  return {
    ledger_id: ledger.id, code: ledger.code, as_of: asOf,
    balance_as_per_books: book,
    uncleared_deposits: deposits,
    uncleared_withdrawals: withdrawals,
    balance_as_per_bank: r2(book - deposits + withdrawals),
    uncleared,
  };
}

module.exports = {
  outstanding,
  partySummary,
  ageing,
  statement,
  register,
  gstReport,
  pendingEwayBills,
  trialBalance,
  ledgerStatement,
  reconciliation,
  refreshBalances,
  bankReconciliation,
};
