/**
 * Sales vouchers (linked to Client Master) and purchase vouchers (linked to Vendor Master).
 * Each function takes a side context (ctx.cfg = SALES or PURCHASE config); the sides never share tables.
 *
 * Transaction-time details: every voucher stores the party snapshot (GSTIN, state, addresses, terms ...)
 * and company GST settings as they were on the voucher date. Reports read these stored values.
 */
const pool = require('../../config/db');
const {
  httpError, today, addDays, parseDate, cleanText, isTruthy,
} = require('../common');
const { buildSnapshot } = require('../party/partyService');
const child = require('../party/childService');
const { assertCompanyUsable } = require('../party/access');
const { registerTransactionSource } = require('../party/transactions');
const {
  SIDES, PAYMENT_MODES, INCOME_GROUPS, PURCHASE_LINE_GROUPS,
} = require('../../config/accountingConfig');
const { requireBooks, openFinancialYear, settingsAt } = require('./books');
const { resolveLedger, resolveMapping } = require('./ledgers');
const { nextVoucherNumber } = require('./series');
const { determineSupply, computeLines, isGoods } = require('./gst');
const { buildPostings, postEntries, reverseEntries, LIVE_ENTRY_SQL } = require('./posting');
const {
  r2, writeLog, diff, withTransaction, requireCompanyId,
} = require('./common');

const AUDIT_HEADER_FIELDS = [
  'voucher_date', 'branch_id', 'reference_no', 'reference_date', 'due_date', 'place_of_supply', 'supply_type',
  'tax_treatment', 'reverse_charge', 'against_voucher_id', 'payment_mode', 'cash_bank_ledger_id', 'instrument_no',
  'instrument_date', 'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'round_off',
  'total_amount', 'narration',
];
const VOUCHER_COLUMNS = [
  'company_id', 'branch_id', 'financial_year_id', 'voucher_type', 'series_id', 'voucher_no', 'voucher_date', 'posting_date',
  'party_code', 'party_name', 'party_gstin', 'party_state_code', 'party_registration_type', 'company_gstin',
  'company_state_code', 'place_of_supply', 'supply_type', 'tax_treatment', 'reverse_charge', 'reference_no',
  'reference_date', 'due_date', 'against_voucher_id', 'payment_mode', 'cash_bank_ledger_id', 'instrument_no',
  'instrument_date', 'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'round_off',
  'total_amount', 'party_effect', 'narration', 'party_snapshot', 'company_snapshot', 'billing_address', 'shipping_address',
];
const LINE_COLUMNS = [
  'ledger_id', 'item_code', 'description', 'hsn_sac', 'qty', 'unit', 'rate', 'discount_percent', 'discount_amount',
  'taxable_value', 'gst_rate', 'cgst_rate', 'sgst_rate', 'igst_rate', 'cgst_amount', 'sgst_amount', 'igst_amount',
  'cess_rate', 'cess_amount', 'itc_eligible', 'line_total',
];
const JSON_COLUMNS = ['party_snapshot', 'company_snapshot', 'billing_address', 'shipping_address'];
const CASH_RECEIPT_LIMIT = 200000;
const CASH_PAYMENT_LIMIT = 10000;
const EWAY_NO_RE = /^\d{12}$/;
const TRANSPORT_MODES = { ROAD: '1', RAIL: '2', AIR: '3', SHIP: '4' };
const PART_B_REASONS = ['FIRST_TIME', 'BREAKDOWN', 'TRANSSHIPMENT', 'OTHERS'];

// ---------- helpers ----------

function typeConfig(side, type) {
  const t = side.voucherTypes[type];
  if (!t || t.opening) {
    const allowed = Object.keys(side.voucherTypes).filter((k) => !side.voucherTypes[k].opening);
    throw httpError(400, `voucher_type must be one of ${allowed.join(', ')}`);
  }
  return t;
}

function invoiceType(side) {
  return Object.keys(side.voucherTypes).find((k) => side.voucherTypes[k].due);
}

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function loadVoucher(conn, side, ctx, id, { forUpdate = false } = {}) {
  const [rows] = await conn.query(`SELECT * FROM ${side.table} WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
  if (!rows.length || !ctx.canSeeCompany(rows[0].company_id)) throw httpError(404, 'Voucher not found');
  return rows[0];
}

async function loadPartyRow(conn, side, companyId, partyId) {
  const [[party]] = await conn.query(`SELECT * FROM ${side.partyCfg.table} WHERE id = ?`, [Number(partyId) || 0]);
  if (!party || party.company_id !== Number(companyId)) {
    throw httpError(400, `${side.partyFk} ${partyId} is not a ${side.partyCfg.label.toLowerCase()} of this company`);
  }
  return party;
}

/** The party plus records merged into it — history and bills follow merges. */
async function partyGroup(conn, side, partyId) {
  const [rows] = await conn.query(`SELECT id FROM ${side.partyCfg.table} WHERE merged_into_id = ?`, [partyId]);
  return [Number(partyId), ...rows.map((r) => r.id)];
}

function compactAddress(a) {
  if (!a) return null;
  const keys = ['id', 'address_type', 'label', 'line1', 'line2', 'landmark', 'city', 'state', 'state_code', 'pincode', 'country', 'contact_name', 'contact_phone'];
  return Object.fromEntries(keys.map((k) => [k, a[k] ?? null]));
}

async function selectAddress(conn, side, partyId, date, rootId, snapshot, types) {
  if (rootId) {
    const byRoot = await child.loadChildVersions(conn, side.partyCfg, 'addresses', [partyId]);
    const found = child.resolveChildren(side.partyCfg, 'addresses', byRoot, date, { includeUpcoming: false })
      .find((a) => a.id === Number(rootId));
    if (!found) throw httpError(400, `Address ${rootId} is not an active address of this ${side.partyCfg.label.toLowerCase()} on ${date}`);
    return compactAddress(found);
  }
  for (const t of types) if (snapshot.addresses?.[t]) return compactAddress(snapshot.addresses[t]);
  return null;
}

async function findLedgerByCodeOrName(conn, companyId, text, date, groups) {
  const [rows] = await conn.query(
    `SELECT l.id FROM ledgers l JOIN ledger_versions v ON v.ledger_id = l.id AND v.effective_to IS NULL
     WHERE l.company_id = ? AND (l.code = ? OR v.name = ?) LIMIT 1`,
    [companyId, text.toUpperCase(), text]
  );
  if (!rows.length) return null;
  try {
    return await resolveLedger(conn, companyId, rows[0].id, date, { groups });
  } catch {
    return null;
  }
}

function openAmountSql(side, alias = 'v', asOf = null) {
  const cond = asOf
    ? "a.allocation_date <= ? AND (a.status = 'ACTIVE' OR a.reversed_at > ?)"
    : "a.status = 'ACTIVE'";
  return {
    sql: `(${alias}.total_amount - COALESCE((SELECT SUM(a.amount) FROM ${side.allocTable} a
            WHERE (a.from_voucher_id = ${alias}.id OR a.to_voucher_id = ${alias}.id) AND ${cond}), 0))`,
    params: asOf ? [asOf, `${asOf} 23:59:59`] : [],
  };
}

async function openAmount(conn, side, voucherId) {
  const open = openAmountSql(side);
  const [[row]] = await conn.query(`SELECT ${open.sql} AS open_amount FROM ${side.table} v WHERE v.id = ?`, [...open.params, voucherId]);
  return r2(row.open_amount);
}

/** Receivable (clients) / payable (vendors) net of advances, from open bills. */
async function partyNetOpen(conn, side, partyIds, excludeVoucherId = 0) {
  const open = openAmountSql(side);
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(CASE WHEN v.party_effect = ? THEN ${open.sql} ELSE -${open.sql} END), 0) AS net
     FROM ${side.table} v WHERE v.${side.partyFk} IN (?) AND v.status = 'POSTED' AND v.id <> ?`,
    [side.receivableEffect, ...open.params, ...open.params, partyIds, excludeVoucherId]
  );
  return r2(row.net);
}

async function refreshPartyBalances(conn, side, partyId) {
  const open = openAmountSql(side);
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(CASE WHEN v.party_effect = ? THEN ${open.sql} ELSE 0 END), 0) AS outstanding,
            COALESCE(SUM(CASE WHEN v.party_effect <> ? THEN ${open.sql} ELSE 0 END), 0) AS advance
     FROM ${side.table} v WHERE v.${side.partyFk} = ? AND v.status = 'POSTED'`,
    [side.receivableEffect, ...open.params, side.receivableEffect, ...open.params, partyId]
  );
  await conn.query(
    `UPDATE ${side.partyCfg.table} SET outstanding_balance = ?, advance_balance = ? WHERE id = ?`,
    [r2(row.outstanding), r2(row.advance), partyId]
  );
}

function auditMeta(side, ctx, v, extra) {
  return {
    companyId: v.company_id, partyFk: side.partyFk, partyId: v[side.partyFk], voucherId: v.id,
    actor: ctx.actor, role: ctx.role, ...extra,
  };
}

function rawLinesFromRows(rows) {
  return rows.map((l) => ({
    ledger_id: l.ledger_id, item_code: l.item_code, description: l.description, hsn_sac: l.hsn_sac,
    qty: Number(l.qty), unit: l.unit, rate: Number(l.rate), discount_percent: Number(l.discount_percent),
    gst_rate: Number(l.gst_rate), cess_rate: Number(l.cess_rate), itc_eligible: !!l.itc_eligible,
  }));
}

// ---------- build (shared by create and amend) ----------

async function buildVoucher(conn, side, ctx, input, existing = null, existingLines = []) {
  const fk = side.partyFk;
  const type = existing ? existing.voucher_type : cleanText(input.voucher_type)?.toUpperCase();
  const typeCfg = typeConfig(side, type);
  const companyId = existing ? existing.company_id : requireCompanyId(input.company_id);
  const books = await requireBooks(conn, companyId);
  const pick = (field) => (input[field] !== undefined ? input[field] : existing?.[field]);
  const warnings = [];

  const date = parseDate(input.voucher_date, 'voucher_date') || existing?.voucher_date || today();
  if (date > today()) throw httpError(400, 'voucher_date cannot be in the future');
  if (date < books.books_start_date) throw httpError(400, `voucher_date cannot be before the books start date ${books.books_start_date}`);
  const fy = await openFinancialYear(conn, companyId, date, ctx.actor);
  if (existing && fy.id !== existing.financial_year_id) {
    throw httpError(400, 'voucher_date must stay in the same financial year (the voucher number belongs to it) — cancel and re-enter instead');
  }

  const partyId = existing ? existing[fk] : Number(input[fk]);
  if (!partyId) throw httpError(400, `${fk} is required`);
  const party = await loadPartyRow(conn, side, companyId, partyId);
  if (!existing && party.merged_into_id) throw httpError(400, `${side.partyCfg.label} ${party.code} was merged into #${party.merged_into_id} — use that record`);
  if (party.approval_status !== 'APPROVED') throw httpError(400, `${side.partyCfg.label} ${party.code} is not approved (${party.approval_status})`);
  const snapshot = await buildSnapshot(side.partyCfg, party, date);
  const holdField = side.partyCfg.holdField;
  if (typeCfg.lines && snapshot.profile.status !== 'ACTIVE') throw httpError(400, `${side.partyCfg.label} ${party.code} is inactive on ${date}`);
  if (typeCfg.holdBlocks && snapshot.profile[holdField]) {
    throw httpError(409, `${side.partyCfg.label} ${party.code} is on ${holdField.replace('_', ' ')}${snapshot.profile.hold_reason ? ` (${snapshot.profile.hold_reason})` : ''}`);
  }
  const settings = await settingsAt(conn, companyId, date);

  let branchId = pick('branch_id') ? Number(pick('branch_id')) : null;
  if (branchId) {
    const [[b]] = await conn.query('SELECT id FROM branches WHERE id = ? AND company_id = ?', [branchId, companyId]);
    if (!b) throw httpError(400, 'branch_id does not belong to this company');
  } else branchId = null;

  const text = (field, max) => {
    const value = cleanText(pick(field));
    if (value && value.length > max) throw httpError(400, `${field} must be at most ${max} characters`);
    return value ?? null;
  };
  const v = {
    company_id: companyId,
    branch_id: branchId,
    financial_year_id: fy.id,
    voucher_type: type,
    voucher_date: date,
    posting_date: date,
    [fk]: partyId,
    party_code: party.code,
    party_name: snapshot.profile.name,
    party_gstin: snapshot.profile.gstin,
    party_state_code: snapshot.profile.state_code,
    party_registration_type: snapshot.profile.gst_registration_type,
    company_gstin: settings.gstin,
    company_state_code: settings.state_code,
    party_effect: typeCfg.effect,
    reference_no: text('reference_no', 50),
    reference_date: parseDate(pick('reference_date'), 'reference_date'),
    narration: text('narration', 1000),
    party_snapshot: snapshot,
    company_snapshot: {
      trade_name: settings.trade_name, gstin: settings.gstin, pan: settings.pan, state_code: settings.state_code,
      gst_registration_type: settings.gst_registration_type, address: settings.address, city: settings.city,
      pincode: settings.pincode, phone: settings.phone, email: settings.email, settings_version_id: settings.id,
    },
    place_of_supply: null, supply_type: null, tax_treatment: null, reverse_charge: 0, due_date: null, against_voucher_id: null,
    payment_mode: null, cash_bank_ledger_id: null, instrument_no: null, instrument_date: null,
    taxable_value: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, cess_amount: 0, round_off: 0,
    billing_address: null, shipping_address: null,
  };
  let lines = [];

  if (typeCfg.lines) {
    const billingId = input.billing_address_id !== undefined ? input.billing_address_id : json(existing?.billing_address)?.id;
    const shippingId = input.shipping_address_id !== undefined ? input.shipping_address_id : json(existing?.shipping_address)?.id;
    v.billing_address = await selectAddress(conn, side, partyId, date, billingId, snapshot, side.billingTypes);
    v.shipping_address = await selectAddress(conn, side, partyId, date, shippingId, snapshot, side.shippingTypes);

    let reverseCharge = pick('reverse_charge');
    if (reverseCharge === undefined || reverseCharge === null) reverseCharge = !!snapshot.profile.tax_settings?.rcm_applicable;
    const supply = determineSupply(side, settings, snapshot, v.shipping_address, {
      place_of_supply: pick('place_of_supply'), tax_treatment: pick('tax_treatment'), reverse_charge: isTruthy(reverseCharge) || reverseCharge === true,
    });
    if (supply.zeroTax) warnings.push(`No GST charged: ${supply.zeroReason}`);

    const rawLines = input.lines !== undefined ? input.lines : rawLinesFromRows(existingLines);
    const computed = computeLines(rawLines, supply, { isPurchase: side.key === 'purchases', roundOff: !!settings.invoice_round_off });
    const lineGroups = side.key === 'sales' ? INCOME_GROUPS : PURCHASE_LINE_GROUPS;
    let defaultLedger = null;
    if (type === 'PURCHASE_INVOICE' && snapshot.profile.default_purchase_ledger) {
      defaultLedger = await findLedgerByCodeOrName(conn, companyId, snapshot.profile.default_purchase_ledger, date, lineGroups);
      if (!defaultLedger) warnings.push(`Vendor default purchase ledger "${snapshot.profile.default_purchase_ledger}" not found — mapped ${typeCfg.lineKey} ledger used`);
    }
    defaultLedger = defaultLedger || await resolveMapping(conn, companyId, typeCfg.lineKey, date);
    for (const [i, line] of computed.lines.entries()) {
      line.ledger_id = line.ledger_id
        ? (await resolveLedger(conn, companyId, line.ledger_id, date, { groups: lineGroups, label: `lines[${i}].ledger_id` })).id
        : defaultLedger.id;
    }
    lines = computed.lines;
    Object.assign(v, {
      place_of_supply: supply.placeOfSupply, supply_type: supply.supplyType, tax_treatment: supply.taxTreatment,
      reverse_charge: supply.reverseCharge ? 1 : 0,
      taxable_value: computed.totals.taxable_value, cgst_amount: computed.totals.cgst_amount, sgst_amount: computed.totals.sgst_amount,
      igst_amount: computed.totals.igst_amount, cess_amount: computed.totals.cess_amount, round_off: computed.totals.round_off,
      total_amount: computed.totals.total_amount,
    });
    if (typeCfg.gstDoc && !supply.zeroTax && lines.some((l) => !l.hsn_sac)) warnings.push('HSN / SAC missing on some lines (needed for GST reports)');

    const againstId = pick('against_voucher_id');
    if (againstId) {
      if (!typeCfg.against) throw httpError(400, `against_voucher_id is not used for ${type}`);
      const [[orig]] = await conn.query(`SELECT * FROM ${side.table} WHERE id = ?`, [Number(againstId)]);
      const group = await partyGroup(conn, side, partyId);
      if (!orig || orig.company_id !== companyId || !group.includes(orig[fk])) throw httpError(400, 'against_voucher_id is not a voucher of this party');
      if (orig.voucher_type !== invoiceType(side) || orig.status !== 'POSTED') throw httpError(400, `against_voucher_id must be a posted ${invoiceType(side)}`);
      if (orig.voucher_date > date) throw httpError(400, 'The original invoice is dated after this voucher');
      v.against_voucher_id = orig.id;
      if (!v.reference_no) { v.reference_no = orig.voucher_no; v.reference_date = orig.voucher_date; }
    }

    if (typeCfg.due) {
      const due = parseDate(input.due_date, 'due_date')
        || (existing && input.voucher_date === undefined ? existing.due_date : null)
        || addDays(date, Number(snapshot.financial?.credit_period_days || 0));
      if (due < date) throw httpError(400, 'due_date cannot be before voucher_date');
      v.due_date = due;
    }

    if (typeCfg.supplierRef) {
      if (!v.reference_no || !v.reference_date) throw httpError(400, 'reference_no and reference_date (supplier invoice no / date) are required');
      if (v.reference_date > date) throw httpError(400, 'reference_date (supplier invoice date) cannot be after voucher_date');
      const [dup] = await conn.query(
        `SELECT voucher_no FROM ${side.table} WHERE ${fk} = ? AND voucher_type = ? AND financial_year_id = ? AND reference_no = ?
           AND status = 'POSTED' AND id <> ?`,
        [partyId, type, fy.id, v.reference_no, existing?.id || 0]
      );
      if (dup.length) throw httpError(409, `Supplier invoice ${v.reference_no} is already entered as ${dup[0].voucher_no}`);
    }

    if (typeCfg.eway && lines.some(isGoods) && v.total_amount > Number(settings.eway_bill_threshold)) {
      warnings.push(`E-way bill required — consignment value above ₹${Number(settings.eway_bill_threshold)}`);
    }
  } else {
    const amount = Number(pick('amount') ?? existing?.total_amount);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'amount must be greater than zero');
    const mode = (cleanText(pick('payment_mode')) || 'BANK_TRANSFER').toUpperCase();
    if (!PAYMENT_MODES.includes(mode)) throw httpError(400, `payment_mode must be one of ${PAYMENT_MODES.join(', ')}`);
    const ledgerId = pick('cash_bank_ledger_id');
    const ledger = ledgerId
      ? await resolveLedger(conn, companyId, ledgerId, date, { groups: ['CASH', 'BANK'], label: 'cash_bank_ledger_id' })
      : await resolveMapping(conn, companyId, mode === 'CASH' ? 'CASH' : 'BANK', date);
    if (mode === 'CASH' && ledger.group !== 'CASH') throw httpError(400, 'payment_mode CASH needs a cash ledger');
    if (mode !== 'CASH' && ledger.group === 'CASH') throw httpError(400, `payment_mode ${mode} needs a bank ledger`);
    Object.assign(v, {
      total_amount: r2(amount), payment_mode: mode, cash_bank_ledger_id: ledger.id,
      instrument_no: text('instrument_no', 50), instrument_date: parseDate(pick('instrument_date'), 'instrument_date'),
    });
    if (mode === 'CHEQUE' && !v.instrument_no) throw httpError(400, 'instrument_no (cheque number) is required for CHEQUE');
    if (mode === 'CASH' && type === 'RECEIPT' && v.total_amount >= CASH_RECEIPT_LIMIT) {
      warnings.push(`Cash receipt of ₹${CASH_RECEIPT_LIMIT} or more is not allowed under section 269ST`);
    }
    if (mode === 'CASH' && ['PAYMENT', 'REFUND'].includes(type) && v.total_amount > CASH_PAYMENT_LIMIT) {
      warnings.push(`Cash payment above ₹${CASH_PAYMENT_LIMIT} in a day may be disallowed under section 40A(3)`);
    }
  }
  return { v, lines, typeCfg, warnings, snapshot, settings, fy };
}

async function creditCheck(conn, side, ctx, built, input, excludeId = 0) {
  if (!built.typeCfg.creditCheck) return;
  const limit = Number(built.snapshot.financial?.credit_limit || 0);
  if (!limit) return;
  const group = await partyGroup(conn, side, built.v[side.partyFk]);
  const exposure = r2((await partyNetOpen(conn, side, group, excludeId)) + built.v.total_amount);
  if (exposure <= limit) return;
  const msg = `Credit limit exceeded: exposure ₹${exposure} > limit ₹${limit}`;
  if (built.settings.credit_limit_action === 'WARN') { built.warnings.push(msg); return; }
  if (isTruthy(input.override_credit_limit) && ctx.can('approve')) { built.warnings.push(`${msg} (overridden by ${ctx.actor})`); return; }
  throw Object.assign(httpError(409, `${msg} — needs override_credit_limit=true by a user with ${side.key}.approve`), {
    details: { credit_limit: limit, exposure },
  });
}

async function insertVoucherRow(conn, v) {
  const cols = VOUCHER_COLUMNS;
  const [ins] = await conn.query(
    `INSERT INTO ${v.__table} (${cols.join(', ')}, ${v.__fk}, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`,
    [...cols.map((c) => (JSON_COLUMNS.includes(c) && v[c] ? JSON.stringify(v[c]) : v[c] ?? null)), v[v.__fk], v.__actor]
  );
  return ins.insertId;
}

async function insertLines(conn, side, voucherId, lines) {
  if (!lines.length) return;
  await conn.query(
    `INSERT INTO ${side.linesTable} (voucher_id, line_no, ${LINE_COLUMNS.join(', ')}) VALUES ?`,
    [lines.map((l, i) => [voucherId, i + 1, ...LINE_COLUMNS.map((c) => l[c] ?? null)])]
  );
}

// ---------- allocation ----------

async function applyAllocation(conn, side, ctx, a, b, amount, date, remarks) {
  const fk = side.partyFk;
  if (a.id === b.id) throw httpError(400, 'A voucher cannot be allocated against itself');
  if (a.status !== 'POSTED' || b.status !== 'POSTED') throw httpError(400, 'Only posted vouchers can be allocated');
  if (a.party_effect === b.party_effect) throw httpError(400, `${a.voucher_no} and ${b.voucher_no} are on the same side (${a.party_effect}) — allocate a settlement against a bill`);
  const groupA = await partyGroup(conn, side, a[fk]);
  const groupB = await partyGroup(conn, side, b[fk]);
  if (!groupA.includes(b[fk]) && !groupB.includes(a[fk])) throw httpError(400, 'Vouchers belong to different parties');
  const bill = a.party_effect === side.receivableEffect ? a : b;
  const settle = bill === a ? b : a;
  const allocDate = date || [today(), bill.voucher_date, settle.voucher_date].sort().pop();
  if (allocDate < bill.voucher_date || allocDate < settle.voucher_date) throw httpError(400, 'allocation_date cannot be before either voucher date');
  if (allocDate > today()) throw httpError(400, 'allocation_date cannot be in the future');
  await openFinancialYear(conn, bill.company_id, allocDate < bill.posting_date ? bill.posting_date : allocDate, ctx.actor);
  const amt = r2(amount);
  if (!(amt > 0)) throw httpError(400, 'amount must be greater than zero');
  const openBill = await openAmount(conn, side, bill.id);
  const openSettle = await openAmount(conn, side, settle.id);
  if (amt > openBill) throw httpError(400, `Only ₹${openBill} of ${bill.voucher_no} is open`);
  if (amt > openSettle) throw httpError(400, `Only ₹${openSettle} of ${settle.voucher_no} is unallocated`);
  const [ins] = await conn.query(
    `INSERT INTO ${side.allocTable} (company_id, ${fk}, from_voucher_id, to_voucher_id, amount, allocation_date, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [bill.company_id, bill[fk], settle.id, bill.id, amt, allocDate, remarks || null, ctx.actor]
  );
  await writeLog(conn, side.auditTable, auditMeta(side, ctx, settle, {
    entityType: 'ALLOCATION', entityId: ins.insertId, action: 'ALLOCATED', effectiveDate: allocDate, reason: remarks,
  }), [{ field: 'allocation', old: null, new: `${settle.voucher_no} → ${bill.voucher_no}: ${amt}` }]);
  return ins.insertId;
}

/** FIFO against the oldest open opposite items (by due date, then date). */
async function autoAllocateInternal(conn, side, ctx, voucher, date) {
  let remaining = await openAmount(conn, side, voucher.id);
  if (remaining <= 0) return 0;
  const group = await partyGroup(conn, side, voucher[side.partyFk]);
  const open = openAmountSql(side);
  const [candidates] = await conn.query(
    `SELECT v.*, ${open.sql} AS open_amount FROM ${side.table} v
     WHERE v.${side.partyFk} IN (?) AND v.status = 'POSTED' AND v.party_effect <> ? AND v.id <> ?
     HAVING open_amount > 0.004
     ORDER BY COALESCE(v.due_date, v.voucher_date), v.voucher_date, v.id`,
    [...open.params, group, voucher.party_effect, voucher.id]
  );
  let count = 0;
  for (const c of candidates) {
    if (remaining <= 0) break;
    const amt = r2(Math.min(remaining, Number(c.open_amount)));
    const allocDate = [date || today(), c.voucher_date, voucher.voucher_date].sort().pop();
    await applyAllocation(conn, side, ctx, voucher, c, amt, allocDate, 'Auto allocation (FIFO)');
    remaining = r2(remaining - amt);
    count += 1;
  }
  return count;
}

async function reverseAllocationRow(conn, side, ctx, alloc, reason) {
  await conn.query(
    `UPDATE ${side.allocTable} SET status = 'REVERSED', reversed_by = ?, reversed_at = NOW(), reverse_reason = ? WHERE id = ?`,
    [ctx.actor, reason, alloc.id]
  );
  await writeLog(conn, side.auditTable, {
    companyId: alloc.company_id, partyFk: side.partyFk, partyId: alloc[side.partyFk], voucherId: alloc.from_voucher_id,
    entityType: 'ALLOCATION', entityId: alloc.id, action: 'UNALLOCATED', effectiveDate: today(), reason, actor: ctx.actor, role: ctx.role,
  }, [{ field: 'allocation', old: `${alloc.from_voucher_id} → ${alloc.to_voucher_id}: ${alloc.amount}`, new: null }]);
}

async function applyRequestedAllocations(conn, side, ctx, voucher, input) {
  const list = input.allocations;
  if (list !== undefined) {
    if (!Array.isArray(list)) throw httpError(400, 'allocations must be an array of { voucher_id, amount }');
    for (const [i, item] of list.entries()) {
      const [[other]] = await conn.query(`SELECT * FROM ${side.table} WHERE id = ? AND company_id = ? FOR UPDATE`, [Number(item.voucher_id) || 0, voucher.company_id]);
      if (!other) throw httpError(400, `allocations[${i}].voucher_id not found`);
      await applyAllocation(conn, side, ctx, voucher, other, item.amount, parseDate(item.allocation_date, `allocations[${i}].allocation_date`), cleanText(item.remarks));
    }
  }
  if (voucher.against_voucher_id) {
    const open = await openAmount(conn, side, voucher.against_voucher_id);
    const mine = await openAmount(conn, side, voucher.id);
    const amt = Math.min(open, mine);
    if (amt > 0) {
      const [[orig]] = await conn.query(`SELECT * FROM ${side.table} WHERE id = ?`, [voucher.against_voucher_id]);
      await applyAllocation(conn, side, ctx, voucher, orig, amt, null, 'Against original invoice');
    }
  }
  if (isTruthy(input.auto_allocate)) await autoAllocateInternal(conn, side, ctx, voucher, null);
}

// ---------- create / amend / cancel ----------

async function createVoucher(ctx, body = {}) {
  const side = ctx.cfg;
  ctx.assert('create');
  await assertCompanyUsable(ctx, body.company_id);
  let warnings = [];
  const id = await withTransaction(async (conn) => {
    const built = await buildVoucher(conn, side, ctx, body);
    await creditCheck(conn, side, ctx, built, body);
    const { v, lines } = built;
    const number = await nextVoucherNumber(conn, {
      companyId: v.company_id, voucherType: v.voucher_type, seriesId: body.series_id, branchId: v.branch_id, fy: built.fy,
      date: v.voucher_date, table: side.table,
    });
    v.series_id = number.seriesId;
    v.voucher_no = number.voucherNo;
    v.revision = 1;
    v.id = await insertVoucherRow(conn, { ...v, __table: side.table, __fk: side.partyFk, __actor: ctx.actor });
    await insertLines(conn, side, v.id, lines);
    await postEntries(conn, side, v, await buildPostings(conn, side, built.typeCfg, v, lines), ctx.actor);
    const [[row]] = await conn.query(`SELECT * FROM ${side.table} WHERE id = ?`, [v.id]);
    await applyRequestedAllocations(conn, side, ctx, row, body);
    await refreshPartyBalances(conn, side, v[side.partyFk]);
    await writeLog(conn, side.auditTable, auditMeta(side, ctx, v, {
      entityType: 'VOUCHER', entityId: v.id, action: 'CREATED', effectiveDate: v.voucher_date, fyCode: built.fy.code,
      reason: cleanText(body.reason),
    }), [
      { field: 'voucher_no', old: null, new: `${v.voucher_type} ${v.voucher_no}` },
      ...diff({}, v, AUDIT_HEADER_FIELDS),
      ...(lines.length ? [{ field: 'lines', old: null, new: `${lines.length} line(s)` }] : []),
      ...built.warnings.map((w) => ({ field: 'warning', old: null, new: w })),
    ]);
    warnings = built.warnings;
    return v.id;
  });
  return { ...(await getVoucher(ctx, id)), warnings };
}

async function amendVoucher(ctx, id, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  for (const f of ['voucher_type', 'company_id', side.partyFk, 'voucher_no', 'series_id']) {
    if (body[f] !== undefined) throw httpError(400, `${f} cannot be changed — cancel the voucher and enter a new one`);
  }
  const reason = cleanText(body.reason);
  if (!reason) throw httpError(400, 'reason is required to amend a posted voucher');
  let warnings = [];
  await withTransaction(async (conn) => {
    const existing = await loadVoucher(conn, side, ctx, id, { forUpdate: true });
    if (existing.status !== 'POSTED') throw httpError(400, `Voucher is ${existing.status}`);
    if (existing.voucher_type === 'OPENING_BALANCE') throw httpError(400, `Opening bills are changed via PUT /api/${side.key}/${side.partyPath}/:id/opening-bills`);
    await openFinancialYear(conn, existing.company_id, existing.voucher_date, ctx.actor);
    const [oldLines] = await conn.query(`SELECT * FROM ${side.linesTable} WHERE voucher_id = ? ORDER BY line_no`, [existing.id]);
    const built = await buildVoucher(conn, side, ctx, body, existing, oldLines);
    const { v, lines } = built;
    const [[{ allocated }]] = await conn.query(
      `SELECT COALESCE(SUM(amount), 0) AS allocated FROM ${side.allocTable}
       WHERE (from_voucher_id = ? OR to_voucher_id = ?) AND status = 'ACTIVE'`,
      [existing.id, existing.id]
    );
    if (v.total_amount < Number(allocated)) {
      throw httpError(400, `New total ₹${v.total_amount} is below the allocated ₹${Number(allocated)} — remove allocations first`);
    }
    if (v.total_amount > Number(existing.total_amount)) await creditCheck(conn, side, ctx, built, body, existing.id);

    await conn.query(
      `INSERT INTO ${side.revisionTable} (voucher_id, revision, data, reason, changed_by) VALUES (?, ?, ?, ?, ?)`,
      [existing.id, existing.revision, JSON.stringify({ voucher: existing, lines: oldLines }), reason, ctx.actor]
    );
    await reverseEntries(conn, side, existing.id, existing.revision, ctx.actor);
    const cols = VOUCHER_COLUMNS.filter((c) => !['company_id', 'voucher_type', 'series_id', 'voucher_no', 'financial_year_id'].includes(c));
    await conn.query(
      `UPDATE ${side.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, revision = revision + 1, updated_by = ? WHERE id = ?`,
      [...cols.map((c) => (JSON_COLUMNS.includes(c) && v[c] ? JSON.stringify(v[c]) : v[c] ?? null)), ctx.actor, existing.id]
    );
    await conn.query(`DELETE FROM ${side.linesTable} WHERE voucher_id = ?`, [existing.id]);
    await insertLines(conn, side, existing.id, lines);
    const posted = { ...v, id: existing.id, voucher_no: existing.voucher_no, revision: existing.revision + 1 };
    await postEntries(conn, side, posted, await buildPostings(conn, side, built.typeCfg, posted, lines), ctx.actor);
    await refreshPartyBalances(conn, side, existing[side.partyFk]);

    const fmt = (rows) => rows.map((l) => `${l.description} ${Number(l.qty)} x ${Number(l.rate)} @${Number(l.gst_rate)}%`).join('; ');
    const changes = diff(existing, v, AUDIT_HEADER_FIELDS);
    if (lines.length && fmt(oldLines) !== fmt(lines)) changes.push({ field: 'lines', old: fmt(oldLines), new: fmt(lines) });
    await writeLog(conn, side.auditTable, auditMeta(side, ctx, posted, {
      entityType: 'VOUCHER', entityId: existing.id, action: 'AMENDED', effectiveDate: v.voucher_date, fyCode: built.fy.code, reason,
    }), changes.length ? changes : [{ field: 'revision', old: existing.revision, new: existing.revision + 1 }]);
    warnings = built.warnings;
  });
  return { ...(await getVoucher(ctx, id)), warnings };
}

async function cancelVoucher(ctx, id, body = {}) {
  const side = ctx.cfg;
  ctx.assert('cancel');
  const reason = cleanText(body.reason);
  if (!reason) throw httpError(400, 'reason is required');
  await withTransaction(async (conn) => {
    const v = await loadVoucher(conn, side, ctx, id, { forUpdate: true });
    if (v.status !== 'POSTED') throw httpError(400, `Voucher is already ${v.status}`);
    if (v.voucher_type === 'OPENING_BALANCE') throw httpError(400, `Opening bills are changed via PUT /api/${side.key}/${side.partyPath}/:id/opening-bills`);
    await openFinancialYear(conn, v.company_id, v.posting_date, ctx.actor);
    const [eway] = await conn.query(`SELECT id FROM ${side.ewayTable} WHERE voucher_id = ? AND status = 'ACTIVE'`, [v.id]);
    if (eway.length) throw httpError(400, 'Cancel the e-way bill first');
    const [allocs] = await conn.query(
      `SELECT * FROM ${side.allocTable} WHERE (from_voucher_id = ? OR to_voucher_id = ?) AND status = 'ACTIVE'`, [v.id, v.id]
    );
    for (const a of allocs) await reverseAllocationRow(conn, side, ctx, a, `Voucher ${v.voucher_no} cancelled`);
    await reverseEntries(conn, side, v.id, v.revision, ctx.actor);
    await conn.query(
      `UPDATE ${side.table} SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`,
      [ctx.actor, reason, v.id]
    );
    const affected = new Set([v[side.partyFk], ...allocs.map((a) => a[side.partyFk])]);
    for (const p of affected) await refreshPartyBalances(conn, side, p);
    await writeLog(conn, side.auditTable, auditMeta(side, ctx, v, {
      entityType: 'VOUCHER', entityId: v.id, action: 'CANCELLED', effectiveDate: v.voucher_date, reason,
    }), [{ field: 'status', old: 'POSTED', new: 'CANCELLED' }]);
  });
  return getVoucher(ctx, id);
}

// ---------- read ----------

async function getVoucher(ctx, id) {
  const side = ctx.cfg;
  ctx.assert('view');
  const v = await loadVoucher(pool, side, ctx, id);
  const [lines] = await pool.query(
    `SELECT l.*, lg.code AS ledger_code FROM ${side.linesTable} l JOIN ledgers lg ON lg.id = l.ledger_id
     WHERE l.voucher_id = ? ORDER BY l.line_no`,
    [v.id]
  );
  const [allocs] = await pool.query(
    `SELECT a.*, f.voucher_no AS from_voucher_no, f.voucher_type AS from_voucher_type,
            t.voucher_no AS to_voucher_no, t.voucher_type AS to_voucher_type
     FROM ${side.allocTable} a JOIN ${side.table} f ON f.id = a.from_voucher_id JOIN ${side.table} t ON t.id = a.to_voucher_id
     WHERE a.from_voucher_id = ? OR a.to_voucher_id = ? ORDER BY a.id`,
    [v.id, v.id]
  );
  const [eway] = await pool.query(`SELECT * FROM ${side.ewayTable} WHERE voucher_id = ? ORDER BY id DESC`, [v.id]);
  const [entries] = await pool.query(
    `SELECT e.ledger_id, l.code AS ledger_code, e.party_type, e.party_id, e.debit, e.credit
     FROM ledger_entries e JOIN ledgers l ON l.id = e.ledger_id
     WHERE e.source = ? AND e.voucher_id = ? AND e.revision = ? AND ${LIVE_ENTRY_SQL}`,
    [side.source, v.id, v.revision]
  );
  const [[{ revisions }]] = await pool.query(`SELECT COUNT(*) AS revisions FROM ${side.revisionTable} WHERE voucher_id = ?`, [v.id]);
  const num = (x) => (x === null ? null : Number(x));
  const amounts = ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'round_off', 'total_amount'];
  return {
    ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, amounts.includes(k) ? Number(x) : JSON_COLUMNS.includes(k) ? json(x) : x])),
    reverse_charge: !!v.reverse_charge,
    open_amount: v.status === 'POSTED' ? await openAmount(pool, side, v.id) : 0,
    lines: lines.map((l) => ({
      ...l, itc_eligible: !!l.itc_eligible,
      ...Object.fromEntries(['qty', 'rate', 'discount_percent', 'discount_amount', 'taxable_value', 'gst_rate', 'cgst_rate', 'sgst_rate', 'igst_rate',
        'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_rate', 'cess_amount', 'line_total'].map((k) => [k, num(l[k])])),
    })),
    allocations: allocs.map((a) => ({ ...a, amount: Number(a.amount) })),
    eway_bill: eway.find((e) => e.status === 'ACTIVE') || null,
    eway_bill_history: eway,
    ledger_entries: entries.map((e) => ({ ...e, debit: Number(e.debit), credit: Number(e.credit) })),
    previous_revisions: Number(revisions),
  };
}

async function listVouchers(ctx, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const scope = ctx.companyFilter('v.company_id');
  const where = [scope.sql];
  const params = [...scope.params];
  const add = (sql, ...vals) => { where.push(sql); params.push(...vals); };
  if (cleanText(query.company_id)) add('v.company_id = ?', Number(query.company_id));
  if (cleanText(query.voucher_type)) add('v.voucher_type = ?', String(query.voucher_type).toUpperCase());
  if (cleanText(query[side.partyFk])) add(`v.${side.partyFk} IN (?)`, await partyGroup(pool, side, Number(query[side.partyFk])));
  if (cleanText(query.status)) add('v.status = ?', String(query.status).toUpperCase());
  if (cleanText(query.branch_id)) add('v.branch_id = ?', Number(query.branch_id));
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  if (from) add('v.voucher_date >= ?', from);
  if (to) add('v.voucher_date <= ?', to);
  if (cleanText(query.search)) {
    const like = `%${query.search}%`;
    add('(v.voucher_no LIKE ? OR v.reference_no LIKE ? OR v.party_name LIKE ? OR v.party_gstin LIKE ?)', like, like, like, like);
  }
  const open = openAmountSql(side);
  const having = isTruthy(query.open_only) ? 'HAVING open_amount > 0.004' : '';
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const base = `SELECT v.id, v.company_id, v.branch_id, v.voucher_type, v.voucher_no, v.voucher_date, v.${side.partyFk},
                       v.party_code, v.party_name, v.party_gstin, v.reference_no, v.due_date, v.taxable_value,
                       v.cgst_amount + v.sgst_amount + v.igst_amount + v.cess_amount AS tax_amount, v.total_amount,
                       v.party_effect, v.status, v.revision, ${open.sql} AS open_amount
                FROM ${side.table} v WHERE ${where.join(' AND ')} ${having}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM (${base}) x`, [...open.params, ...params]);
  const [rows] = await pool.query(`${base} ORDER BY v.voucher_date DESC, v.id DESC LIMIT ? OFFSET ?`, [...open.params, ...params, limit, (page - 1) * limit]);
  return {
    data: rows.map((r) => ({
      ...r, taxable_value: Number(r.taxable_value), tax_amount: Number(r.tax_amount), total_amount: Number(r.total_amount),
      open_amount: r.status === 'POSTED' ? r2(r.open_amount) : 0,
    })),
    page, limit, total: Number(total),
  };
}

async function listRevisions(ctx, id) {
  const side = ctx.cfg;
  ctx.assert('audit');
  const v = await loadVoucher(pool, side, ctx, id);
  const [rows] = await pool.query(`SELECT * FROM ${side.revisionTable} WHERE voucher_id = ? ORDER BY revision DESC`, [v.id]);
  return { voucher_id: v.id, current_revision: v.revision, previous: rows.map((r) => ({ ...r, data: json(r.data) })) };
}

// ---------- allocation API ----------

async function allocate(ctx, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  return withTransaction(async (conn) => {
    const a = await loadVoucher(conn, side, ctx, body.from_voucher_id, { forUpdate: true });
    const b = await loadVoucher(conn, side, ctx, body.to_voucher_id, { forUpdate: true });
    const allocId = await applyAllocation(conn, side, ctx, a, b, body.amount, parseDate(body.allocation_date, 'allocation_date'), cleanText(body.remarks));
    await refreshPartyBalances(conn, side, a[side.partyFk]);
    if (b[side.partyFk] !== a[side.partyFk]) await refreshPartyBalances(conn, side, b[side.partyFk]);
    const [[row]] = await conn.query(`SELECT * FROM ${side.allocTable} WHERE id = ?`, [allocId]);
    return row;
  });
}

async function autoAllocate(ctx, id, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  await withTransaction(async (conn) => {
    const v = await loadVoucher(conn, side, ctx, id, { forUpdate: true });
    if (v.status !== 'POSTED') throw httpError(400, `Voucher is ${v.status}`);
    const count = await autoAllocateInternal(conn, side, ctx, v, parseDate(body.allocation_date, 'allocation_date'));
    if (!count) throw httpError(400, 'Nothing to allocate — no open amount or no open items on the other side');
    await refreshPartyBalances(conn, side, v[side.partyFk]);
  });
  return getVoucher(ctx, id);
}

async function reverseAllocation(ctx, allocId, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  const reason = cleanText(body.reason);
  if (!reason) throw httpError(400, 'reason is required');
  return withTransaction(async (conn) => {
    const [[alloc]] = await conn.query(`SELECT * FROM ${side.allocTable} WHERE id = ? FOR UPDATE`, [Number(allocId) || 0]);
    if (!alloc || !ctx.canSeeCompany(alloc.company_id)) throw httpError(404, 'Allocation not found');
    if (alloc.status !== 'ACTIVE') throw httpError(400, 'Allocation is already reversed');
    await openFinancialYear(conn, alloc.company_id, alloc.allocation_date, ctx.actor);
    await reverseAllocationRow(conn, side, ctx, alloc, reason);
    await refreshPartyBalances(conn, side, alloc[side.partyFk]);
    const [[row]] = await conn.query(`SELECT * FROM ${side.allocTable} WHERE id = ?`, [alloc.id]);
    return row;
  });
}

// ---------- opening bills ----------

async function loadPartyForCtx(conn, side, ctx, partyId) {
  const [[party]] = await conn.query(`SELECT * FROM ${side.partyCfg.table} WHERE id = ?`, [Number(partyId) || 0]);
  if (!party || !ctx.canSeeCompany(party.company_id)) throw httpError(404, `${side.partyCfg.label} not found`);
  return party;
}

async function masterOpening(conn, side, partyId) {
  const fin = side.partyCfg.financialTable;
  const [[row]] = await conn.query(
    `SELECT opening_balance, opening_balance_type, opening_balance_date FROM ${fin} WHERE ${side.partyFk} = ? ORDER BY effective_from DESC LIMIT 1`,
    [partyId]
  );
  return row || { opening_balance: 0, opening_balance_type: side.receivableEffect, opening_balance_date: null };
}

const signed = (side, amount, effect) => r2(effect === side.receivableEffect ? Number(amount) : -Number(amount));

async function getOpeningBills(ctx, partyId) {
  const side = ctx.cfg;
  ctx.assert('view');
  const party = await loadPartyForCtx(pool, side, ctx, partyId);
  const open = openAmountSql(side);
  const [bills] = await pool.query(
    `SELECT v.id, v.voucher_no, v.reference_no AS bill_no, v.voucher_date AS bill_date, v.due_date, v.total_amount AS amount,
            v.party_effect AS balance_type, ${open.sql} AS open_amount
     FROM ${side.table} v WHERE v.${side.partyFk} = ? AND v.voucher_type = 'OPENING_BALANCE' AND v.status = 'POSTED' ORDER BY v.voucher_date, v.id`,
    [...open.params, party.id]
  );
  const master = await masterOpening(pool, side, party.id);
  const posted = r2(bills.reduce((s, b) => s + signed(side, b.amount, b.balance_type), 0));
  const expected = signed(side, master.opening_balance, master.opening_balance_type);
  return {
    [side.partyFk]: party.id,
    master_opening: { amount: Number(master.opening_balance), type: master.opening_balance_type, date: master.opening_balance_date },
    bills: bills.map((b) => ({ ...b, amount: Number(b.amount), open_amount: r2(b.open_amount) })),
    posted_net: posted,
    difference: r2(expected - posted),
    matches_master: r2(expected - posted) === 0,
  };
}

/**
 * Replaces the party's opening bills (bill-wise opening balance). Without `bills`, one bill is
 * created from the master's opening balance. Existing opening bills must not be allocated.
 */
async function setOpeningBills(ctx, partyId, body = {}) {
  const side = ctx.cfg;
  ctx.assert('create');
  const reason = cleanText(body.reason) ?? 'Opening balance';
  await withTransaction(async (conn) => {
    const party = await loadPartyForCtx(conn, side, ctx, partyId);
    if (party.merged_into_id) throw httpError(400, 'Merged records cannot get opening bills');
    const books = await requireBooks(conn, party.company_id);
    const fy = await openFinancialYear(conn, party.company_id, books.books_start_date, ctx.actor);

    let bills = body.bills;
    if (bills === undefined) {
      const m = await masterOpening(conn, side, party.id);
      const billDate = m.opening_balance_date && m.opening_balance_date < books.books_start_date ? m.opening_balance_date : books.books_start_date;
      bills = Number(m.opening_balance) > 0
        ? [{ bill_no: 'OPENING', bill_date: billDate, amount: m.opening_balance, balance_type: m.opening_balance_type }]
        : [];
    }
    if (!Array.isArray(bills)) throw httpError(400, 'bills must be an array');
    const normalized = bills.map((b, i) => {
      const p = `bills[${i}].`;
      const billNo = cleanText(b.bill_no);
      if (!billNo || billNo.length > 50) throw httpError(400, `${p}bill_no is required (max 50)`);
      const billDate = parseDate(b.bill_date, `${p}bill_date`) || books.books_start_date;
      if (billDate > books.books_start_date) throw httpError(400, `${p}bill_date must be on or before the books start date ${books.books_start_date}`);
      const due = parseDate(b.due_date, `${p}due_date`);
      if (due && due < billDate) throw httpError(400, `${p}due_date cannot be before bill_date`);
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, `${p}amount must be greater than zero`);
      const type = (cleanText(b.balance_type) || side.receivableEffect).toUpperCase();
      if (!['DR', 'CR'].includes(type)) throw httpError(400, `${p}balance_type must be DR or CR`);
      return { billNo, billDate, due, amount: r2(amount), type };
    });

    const [existing] = await conn.query(
      `SELECT * FROM ${side.table} WHERE ${side.partyFk} = ? AND voucher_type = 'OPENING_BALANCE' AND status = 'POSTED' FOR UPDATE`,
      [party.id]
    );
    for (const old of existing) {
      const [allocs] = await conn.query(
        `SELECT id FROM ${side.allocTable} WHERE (from_voucher_id = ? OR to_voucher_id = ?) AND status = 'ACTIVE'`, [old.id, old.id]
      );
      if (allocs.length) throw httpError(409, `Opening bill ${old.reference_no} is already adjusted — reverse its allocations first`);
      await reverseEntries(conn, side, old.id, old.revision, ctx.actor);
      await conn.query(
        `UPDATE ${side.table} SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`,
        [ctx.actor, 'Opening bills replaced', old.id]
      );
    }

    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM ${side.table} WHERE ${side.partyFk} = ? AND voucher_type = 'OPENING_BALANCE'`, [party.id]);
    let seq = Number(n);
    let snapshot;
    try {
      snapshot = await buildSnapshot(side.partyCfg, party, books.books_start_date);
    } catch {
      snapshot = await buildSnapshot(side.partyCfg, party, today());
    }
    const settings = await settingsAt(conn, party.company_id, books.books_start_date);
    for (const b of normalized) {
      seq += 1;
      const v = {
        company_id: party.company_id, branch_id: null, financial_year_id: fy.id, voucher_type: 'OPENING_BALANCE', series_id: null,
        voucher_no: `OB/${party.code}/${seq}`.slice(0, 50), voucher_date: b.billDate, posting_date: books.books_start_date,
        [side.partyFk]: party.id, party_code: party.code, party_name: snapshot.profile.name, party_gstin: snapshot.profile.gstin,
        party_state_code: snapshot.profile.state_code, party_registration_type: snapshot.profile.gst_registration_type,
        company_gstin: settings.gstin, company_state_code: settings.state_code, reference_no: b.billNo, reference_date: b.billDate,
        due_date: b.due || b.billDate, total_amount: b.amount, party_effect: b.type, narration: reason, party_snapshot: snapshot,
        taxable_value: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, cess_amount: 0, round_off: 0, reverse_charge: 0, revision: 1,
      };
      v.id = await insertVoucherRow(conn, { ...v, __table: side.table, __fk: side.partyFk, __actor: ctx.actor });
      await postEntries(conn, side, v, await buildPostings(conn, side, side.voucherTypes.OPENING_BALANCE, v, []), ctx.actor);
    }
    await refreshPartyBalances(conn, side, party.id);
    await writeLog(conn, side.auditTable, {
      companyId: party.company_id, partyFk: side.partyFk, partyId: party.id, entityType: 'OPENING', action: 'OPENING_SET',
      effectiveDate: books.books_start_date, fyCode: fy.code, reason, actor: ctx.actor, role: ctx.role,
    }, [{
      field: 'opening_bills',
      old: existing.map((o) => `${o.reference_no} ${o.party_effect} ${Number(o.total_amount)}`).join('; ') || null,
      new: normalized.map((b) => `${b.billNo} ${b.type} ${b.amount}`).join('; ') || null,
    }]);
  });
  return getOpeningBills(ctx, partyId);
}

// ---------- e-way bill ----------

function parseDateTime(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim().replace('T', ' ');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw httpError(400, `${field} must be YYYY-MM-DD or YYYY-MM-DD HH:mm`);
  parseDate(m[1], field);
  return `${m[1]} ${m[2] || '00'}:${m[3] || '00'}:${m[4] || '00'}`;
}

function nowDateTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${today()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ewayValidity(ewayDateTime, distance, vehicleType) {
  const perDay = vehicleType === 'ODC' ? 20 : 200;
  const days = Math.max(1, Math.ceil(distance / perDay));
  return `${addDays(ewayDateTime.slice(0, 10), days)} 23:59:59`;
}

function readTransport(body, existing = {}) {
  const pick = (f) => (body[f] !== undefined ? body[f] : existing[f]);
  const mode = (cleanText(pick('transport_mode')) || 'ROAD').toUpperCase();
  if (!TRANSPORT_MODES[mode]) throw httpError(400, `transport_mode must be one of ${Object.keys(TRANSPORT_MODES).join(', ')}`);
  const vehicleType = (cleanText(pick('vehicle_type')) || 'REGULAR').toUpperCase();
  if (!['REGULAR', 'ODC'].includes(vehicleType)) throw httpError(400, 'vehicle_type must be REGULAR or ODC');
  const vehicleNo = cleanText(pick('vehicle_no'))?.replace(/[\s-]/g, '').toUpperCase() ?? null;
  if (vehicleNo && !/^[A-Z0-9]{4,15}$/.test(vehicleNo)) throw httpError(400, 'vehicle_no is invalid (e.g. GJ05AB1234)');
  const transporterId = cleanText(pick('transporter_id'))?.toUpperCase() ?? null;
  if (transporterId && !/^[0-9A-Z]{15}$/.test(transporterId)) throw httpError(400, 'transporter_id must be a 15-character GSTIN / TRANSIN');
  if (mode === 'ROAD' && !vehicleNo && !transporterId) throw httpError(400, 'vehicle_no (or transporter_id for Part-B later) is required for ROAD');
  if (mode !== 'ROAD' && !cleanText(pick('transport_doc_no'))) throw httpError(400, `transport_doc_no is required for ${mode}`);
  return {
    transport_mode: mode, vehicle_type: vehicleType, vehicle_no: vehicleNo, transporter_id: transporterId,
    transporter_name: cleanText(pick('transporter_name'))?.slice(0, 150) ?? null,
    transport_doc_no: cleanText(pick('transport_doc_no'))?.slice(0, 30) ?? null,
    transport_doc_date: parseDate(pick('transport_doc_date'), 'transport_doc_date'),
  };
}

async function recordEwayBill(ctx, id, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  await withTransaction(async (conn) => {
    const v = await loadVoucher(conn, side, ctx, id, { forUpdate: true });
    if (!side.voucherTypes[v.voucher_type]?.eway) throw httpError(400, `E-way bills are not used for ${v.voucher_type}`);
    if (v.status !== 'POSTED') throw httpError(400, `Voucher is ${v.status}`);
    const [active] = await conn.query(`SELECT id FROM ${side.ewayTable} WHERE voucher_id = ? AND status = 'ACTIVE'`, [v.id]);
    if (active.length) throw httpError(409, 'An active e-way bill already exists — cancel it first');
    const ewayNo = cleanText(body.eway_bill_no)?.replace(/\s/g, '');
    if (!ewayNo || !EWAY_NO_RE.test(ewayNo)) throw httpError(400, 'eway_bill_no must be 12 digits');
    const ewayDate = parseDateTime(body.eway_bill_date, 'eway_bill_date') || nowDateTime();
    if (ewayDate.slice(0, 10) < v.voucher_date) throw httpError(400, 'eway_bill_date cannot be before the voucher date');
    const distance = Number(body.distance_km);
    if (!Number.isInteger(distance) || distance < 1 || distance > 4000) throw httpError(400, 'distance_km must be a whole number 1-4000');
    const t = readTransport(body);
    const validUpto = t.vehicle_no || t.transport_doc_no ? ewayValidity(ewayDate, distance, t.vehicle_type) : null;
    const [ins] = await conn.query(
      `INSERT INTO ${side.ewayTable} (voucher_id, eway_bill_no, eway_bill_date, valid_upto, transport_mode, distance_km, transporter_id,
         transporter_name, transport_doc_no, transport_doc_date, vehicle_no, vehicle_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [v.id, ewayNo, ewayDate, validUpto, t.transport_mode, distance, t.transporter_id, t.transporter_name, t.transport_doc_no,
        t.transport_doc_date, t.vehicle_no, t.vehicle_type, ctx.actor]
    );
    await writeLog(conn, side.auditTable, auditMeta(side, ctx, v, {
      entityType: 'EWAY_BILL', entityId: ins.insertId, action: 'EWAY_RECORDED', effectiveDate: ewayDate.slice(0, 10),
    }), [{ field: 'eway_bill_no', old: null, new: ewayNo }, { field: 'vehicle_no', old: null, new: t.vehicle_no },
      { field: 'valid_upto', old: null, new: validUpto }]);
  });
  return getVoucher(ctx, id);
}

/** Part-B update (vehicle / transport document) — allowed while the e-way bill is valid. */
async function updateEwayPartB(ctx, id, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  const reason = (cleanText(body.reason) || '').toUpperCase();
  if (!PART_B_REASONS.includes(reason)) throw httpError(400, `reason must be one of ${PART_B_REASONS.join(', ')}`);
  await withTransaction(async (conn) => {
    const v = await loadVoucher(conn, side, ctx, id, { forUpdate: true });
    const [[eway]] = await conn.query(`SELECT * FROM ${side.ewayTable} WHERE voucher_id = ? AND status = 'ACTIVE' FOR UPDATE`, [v.id]);
    if (!eway) throw httpError(404, 'No active e-way bill');
    if (eway.valid_upto && eway.valid_upto < nowDateTime()) throw httpError(400, `E-way bill expired on ${eway.valid_upto}`);
    const t = readTransport(body, eway);
    const validUpto = eway.valid_upto || ewayValidity(nowDateTime(), eway.distance_km, t.vehicle_type);
    const changes = diff(eway, { ...t, valid_upto: validUpto }, [...Object.keys(t), 'valid_upto']);
    if (!changes.length) throw httpError(400, 'No changes to save');
    await conn.query(
      `UPDATE ${side.ewayTable} SET ${Object.keys(t).map((k) => `${k} = ?`).join(', ')}, valid_upto = ?, updated_by = ? WHERE id = ?`,
      [...Object.values(t), validUpto, ctx.actor, eway.id]
    );
    await writeLog(conn, side.auditTable, auditMeta(side, ctx, v, {
      entityType: 'EWAY_BILL', entityId: eway.id, action: 'EWAY_PART_B', effectiveDate: today(), reason,
    }), changes);
  });
  return getVoucher(ctx, id);
}

async function cancelEwayBill(ctx, id, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  const reason = cleanText(body.reason);
  if (!reason) throw httpError(400, 'reason is required');
  await withTransaction(async (conn) => {
    const v = await loadVoucher(conn, side, ctx, id, { forUpdate: true });
    const [[eway]] = await conn.query(`SELECT * FROM ${side.ewayTable} WHERE voucher_id = ? AND status = 'ACTIVE' FOR UPDATE`, [v.id]);
    if (!eway) throw httpError(404, 'No active e-way bill');
    const limit = new Date(`${eway.eway_bill_date.replace(' ', 'T')}`);
    limit.setHours(limit.getHours() + 24);
    if (new Date() > limit) throw httpError(400, 'An e-way bill can only be cancelled within 24 hours of generation');
    await conn.query(
      `UPDATE ${side.ewayTable} SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`,
      [reason, ctx.actor, eway.id]
    );
    await writeLog(conn, side.auditTable, auditMeta(side, ctx, v, {
      entityType: 'EWAY_BILL', entityId: eway.id, action: 'EWAY_CANCELLED', effectiveDate: today(), reason,
    }), [{ field: 'status', old: 'ACTIVE', new: 'CANCELLED' }]);
  });
  return getVoucher(ctx, id);
}

/** E-way bill portal bulk-upload JSON for one voucher (verify on the portal before upload). */
async function ewayBillJson(ctx, id, query = {}) {
  const side = ctx.cfg;
  ctx.assert('view');
  const v = await getVoucher(ctx, id);
  if (!side.voucherTypes[v.voucher_type]?.eway) throw httpError(400, `E-way bills are not used for ${v.voucher_type}`);
  const goods = v.lines.filter((l) => isGoods(l));
  if (!goods.length) throw httpError(400, 'Voucher has no goods lines (all HSN 99xx services)');
  const company = v.company_snapshot || {};
  const partyAddr = v.shipping_address || v.billing_address || {};
  const companySide = {
    gstin: company.gstin || 'URP', name: company.trade_name || '', addr1: company.address || '',
    addr2: '', place: company.city || '', pincode: Number(company.pincode) || null, state: Number(company.state_code),
  };
  const partySide = {
    gstin: v.party_gstin || 'URP', name: v.party_name, addr1: [partyAddr.line1, partyAddr.line2].filter(Boolean).join(', '),
    addr2: partyAddr.landmark || '', place: partyAddr.city || '', pincode: Number(partyAddr.pincode) || null,
    state: Number(partyAddr.state_code || v.party_state_code || v.place_of_supply),
  };
  const outward = ['SALES_INVOICE', 'PURCHASE_RETURN'].includes(v.voucher_type);
  const from = (side.key === 'sales') === outward ? companySide : partySide;
  const to = from === companySide ? partySide : companySide;
  const sub = { SALES_INVOICE: ['1', '', 'INV'], PURCHASE_INVOICE: ['1', '', 'INV'], SALES_RETURN: ['7', '', 'CHL'], PURCHASE_RETURN: ['8', 'Purchase Return', 'CHL'] }[v.voucher_type];
  const eway = v.eway_bill || (query.distance_km ? { distance_km: Number(query.distance_km), transport_mode: 'ROAD', vehicle_type: 'REGULAR' } : null);
  const d = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
  const sum = (f) => r2(goods.reduce((s, l) => s + l[f], 0));
  const hsnTotals = goods.reduce((m, l) => m.set(l.hsn_sac, (m.get(l.hsn_sac) || 0) + l.taxable_value), new Map());
  return {
    version: '1.0.0621',
    billLists: [{
      userGstin: company.gstin,
      supplyType: outward ? 'O' : 'I',
      subSupplyType: sub[0],
      subSupplyDesc: sub[1],
      docType: sub[2],
      docNo: v.voucher_type === 'PURCHASE_INVOICE' ? v.reference_no : v.voucher_no,
      docDate: d(v.voucher_type === 'PURCHASE_INVOICE' ? v.reference_date : v.voucher_date),
      fromGstin: from.gstin, fromTrdName: from.name, fromAddr1: from.addr1, fromAddr2: from.addr2, fromPlace: from.place,
      fromPincode: from.pincode, fromStateCode: from.state, actFromStateCode: from.state,
      toGstin: to.gstin, toTrdName: to.name, toAddr1: to.addr1, toAddr2: to.addr2, toPlace: to.place,
      toPincode: to.pincode, toStateCode: to.state, actToStateCode: to.state,
      transactionType: 1,
      totalValue: sum('taxable_value'),
      cgstValue: sum('cgst_amount'), sgstValue: sum('sgst_amount'), igstValue: sum('igst_amount'), cessValue: sum('cess_amount'),
      TotNonAdvolVal: 0, OthValue: 0,
      totInvValue: v.total_amount,
      transMode: eway ? Number(TRANSPORT_MODES[eway.transport_mode]) : null,
      transDistance: eway ? String(eway.distance_km) : '',
      transporterName: eway?.transporter_name || '', transporterId: eway?.transporter_id || '',
      transDocNo: eway?.transport_doc_no || '', transDocDate: d(eway?.transport_doc_date),
      vehicleNo: eway?.vehicle_no || '', vehicleType: eway?.vehicle_type === 'ODC' ? 'O' : 'R',
      mainHsnCode: Number([...hsnTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]) || null,
      itemList: goods.map((l, i) => ({
        itemNo: i + 1, productName: l.item_code || l.description.slice(0, 100), productDesc: l.description.slice(0, 100),
        hsnCode: Number(l.hsn_sac) || null, quantity: l.qty, qtyUnit: l.unit || 'OTH', taxableAmount: l.taxable_value,
        sgstRate: l.sgst_rate, cgstRate: l.cgst_rate, igstRate: l.igst_rate, cessRate: l.cess_rate, cessNonAdvol: 0,
      })),
    }],
  };
}

// ---------- bank clearance ----------

async function setBankClearance(ctx, id, body = {}) {
  const side = ctx.cfg;
  ctx.assert('edit');
  await withTransaction(async (conn) => {
    const v = await loadVoucher(conn, side, ctx, id, { forUpdate: true });
    if (!side.voucherTypes[v.voucher_type]?.cash) throw httpError(400, 'Bank clearance applies to receipts / payments / refunds');
    if (v.status !== 'POSTED') throw httpError(400, `Voucher is ${v.status}`);
    const [[ledger]] = await conn.query(
      'SELECT v.ledger_group FROM ledger_versions v WHERE v.ledger_id = ? ORDER BY v.effective_from DESC LIMIT 1', [v.cash_bank_ledger_id]
    );
    if (ledger?.ledger_group !== 'BANK') throw httpError(400, 'Voucher is not through a bank ledger');
    const clearedOn = body.cleared_on === null ? null : parseDate(body.cleared_on, 'cleared_on');
    if (body.cleared_on !== null && !clearedOn) throw httpError(400, 'cleared_on is required (or null to mark uncleared)');
    if (clearedOn && clearedOn < v.voucher_date) throw httpError(400, 'cleared_on cannot be before the voucher date');
    await conn.query(`UPDATE ${side.table} SET bank_cleared_on = ?, updated_by = ? WHERE id = ?`, [clearedOn, ctx.actor, v.id]);
    await writeLog(conn, side.auditTable, auditMeta(side, ctx, v, {
      entityType: 'VOUCHER', entityId: v.id, action: 'BANK_CLEARANCE', effectiveDate: clearedOn || today(), reason: cleanText(body.reason),
    }), [{ field: 'bank_cleared_on', old: v.bank_cleared_on, new: clearedOn }]);
  });
  return getVoucher(ctx, id);
}

// ---------- transaction history on Client / Vendor Master ----------

for (const side of Object.values(SIDES)) {
  for (const type of Object.keys(side.voucherTypes)) {
    if (!side.partyCfg.transactionTypes.includes(type)) continue;
    registerTransactionSource(side.partyCfg.key, type, async (partyIds, { from, to }) => {
      const params = [type, partyIds];
      let sql = `SELECT id, voucher_no, voucher_date, reference_no, total_amount, status, ${side.partyFk}
                 FROM ${side.table} WHERE voucher_type = ? AND ${side.partyFk} IN (?)`;
      if (from) { sql += ' AND voucher_date >= ?'; params.push(from); }
      if (to) { sql += ' AND voucher_date <= ?'; params.push(to); }
      const [rows] = await pool.query(`${sql} ORDER BY voucher_date DESC, id DESC LIMIT 200`, params);
      return {
        count: rows.length,
        total: r2(rows.filter((r) => r.status === 'POSTED').reduce((s, r) => s + Number(r.total_amount), 0)),
        items: rows.map((r) => ({ ...r, total_amount: Number(r.total_amount), url: `/api/${side.key}/vouchers/${r.id}` })),
      };
    });
  }
}

module.exports = {
  openAmountSql,
  partyGroup,
  createVoucher,
  amendVoucher,
  cancelVoucher,
  getVoucher,
  listVouchers,
  listRevisions,
  allocate,
  autoAllocate,
  reverseAllocation,
  getOpeningBills,
  setOpeningBills,
  recordEwayBill,
  updateEwayPartB,
  cancelEwayBill,
  ewayBillJson,
  setBankClearance,
  loadPartyForCtx,
};
