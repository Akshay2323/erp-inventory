/** GST place-of-supply, supply type and line tax computation. */
const { httpError, cleanText } = require('../common');
const { normalizeStateCode } = require('../taxValidation');
const { TAX_TREATMENTS } = require('../taxValidation');
const {
  GST_RATES, ZERO_TAX_TREATMENTS, INTER_STATE_TREATMENTS,
} = require('../../config/accountingConfig');
const { r2 } = require('./common');

const HSN_RE = /^(\d{4}|\d{6}|\d{8})$/;
const NO_TAX_VENDOR_TYPES = ['COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'OVERSEAS'];
const MAX_LINES = 500;

/**
 * side: SALES / PURCHASE config; settings: company settings version on voucher date;
 * snapshot: party snapshot on voucher date; shipping: selected shipping / dispatch address.
 */
function determineSupply(side, settings, snapshot, shipping, input) {
  const profile = snapshot.profile;
  const overseas = profile.gst_registration_type === 'OVERSEAS';
  const treatment = cleanText(input.tax_treatment)?.toUpperCase() || profile.tax_treatment || 'TAXABLE';
  if (!TAX_TREATMENTS.includes(treatment)) throw httpError(400, `tax_treatment must be one of ${TAX_TREATMENTS.join(', ')}`);
  const override = input.place_of_supply ? normalizeStateCode(input.place_of_supply, 'place_of_supply') : null;
  const reverseCharge = side.key === 'purchases' && !!input.reverse_charge;

  let supplierState;
  let placeOfSupply;
  if (side.key === 'sales') {
    supplierState = settings.state_code;
    placeOfSupply = override || (overseas ? '96' : null) || shipping?.state_code || profile.place_of_supply
      || profile.state_code || settings.state_code;
  } else {
    supplierState = overseas ? '96' : (profile.state_code || snapshot.addresses?.BILLING?.state_code || settings.state_code);
    placeOfSupply = override || settings.state_code;
  }
  const inter = supplierState !== placeOfSupply || INTER_STATE_TREATMENTS.includes(treatment) || profile.gst_registration_type === 'SEZ';

  let zeroTax = ZERO_TAX_TREATMENTS.includes(treatment);
  let zeroReason = zeroTax ? `tax treatment ${treatment}` : null;
  if (side.key === 'sales' && !['REGULAR', 'SEZ'].includes(settings.gst_registration_type)) {
    zeroTax = true;
    zeroReason = `company is ${settings.gst_registration_type} (bill of supply)`;
  }
  if (side.key === 'purchases' && NO_TAX_VENDOR_TYPES.includes(profile.gst_registration_type) && !reverseCharge) {
    zeroTax = true;
    zeroReason = `vendor is ${profile.gst_registration_type}`;
  }
  const itcAllowed = side.key === 'purchases' && settings.gst_registration_type === 'REGULAR';
  return {
    placeOfSupply, supplyType: inter ? 'INTER' : 'INTRA', taxTreatment: treatment, zeroTax, zeroReason, reverseCharge, itcAllowed,
  };
}

function num(value, field, { min = null, max = null, def = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (def !== undefined) return def;
    throw httpError(400, `${field} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError(400, `${field} must be a number`);
  if (min !== null && n < min) throw httpError(400, `${field} must be >= ${min}`);
  if (max !== null && n > max) throw httpError(400, `${field} must be <= ${max}`);
  return n;
}

/** Validates and computes lines. Ledger ids are resolved by the caller. */
function computeLines(rawLines, supply, { isPurchase, roundOff }) {
  if (!Array.isArray(rawLines) || !rawLines.length) throw httpError(400, 'lines must be a non-empty array');
  if (rawLines.length > MAX_LINES) throw httpError(400, `At most ${MAX_LINES} lines`);
  const lines = rawLines.map((raw, i) => {
    const p = `lines[${i}].`;
    const description = cleanText(raw.description);
    if (!description) throw httpError(400, `${p}description is required`);
    if (description.length > 500) throw httpError(400, `${p}description is too long`);
    const hsn = cleanText(raw.hsn_sac);
    if (hsn && !HSN_RE.test(hsn)) throw httpError(400, `${p}hsn_sac must be 4, 6 or 8 digits`);
    const qty = num(raw.qty, `${p}qty`, { min: 0.001, def: 1 });
    const rate = num(raw.rate, `${p}rate`, { min: 0 });
    const discountPercent = num(raw.discount_percent, `${p}discount_percent`, { min: 0, max: 100, def: 0 });
    const gstRate = num(raw.gst_rate, `${p}gst_rate`, { min: 0, def: 0 });
    if (!GST_RATES.includes(gstRate)) throw httpError(400, `${p}gst_rate must be one of ${GST_RATES.join(', ')}`);
    const cessRate = num(raw.cess_rate, `${p}cess_rate`, { min: 0, max: 400, def: 0 });
    const itcEligible = isPurchase ? !(raw.itc_eligible === false || raw.itc_eligible === 'false' || raw.itc_eligible === 0) : true;

    const gross = r2(qty * rate);
    const discount = r2((gross * discountPercent) / 100);
    const taxable = r2(gross - discount);
    const taxed = !supply.zeroTax;
    const half = gstRate / 2;
    const line = {
      ledger_id: raw.ledger_id ? Number(raw.ledger_id) : null,
      item_code: cleanText(raw.item_code) ?? null,
      description,
      hsn_sac: hsn ?? null,
      qty,
      unit: cleanText(raw.unit)?.toUpperCase().slice(0, 10) ?? null,
      rate,
      discount_percent: discountPercent,
      discount_amount: discount,
      taxable_value: taxable,
      gst_rate: gstRate,
      cgst_rate: taxed && supply.supplyType === 'INTRA' ? half : 0,
      sgst_rate: taxed && supply.supplyType === 'INTRA' ? half : 0,
      igst_rate: taxed && supply.supplyType === 'INTER' ? gstRate : 0,
      cess_rate: taxed ? cessRate : 0,
      itc_eligible: isPurchase ? (itcEligible && supply.itcAllowed ? 1 : 0) : 1,
    };
    line.cgst_amount = r2((taxable * line.cgst_rate) / 100);
    line.sgst_amount = r2((taxable * line.sgst_rate) / 100);
    line.igst_amount = r2((taxable * line.igst_rate) / 100);
    line.cess_amount = r2((taxable * line.cess_rate) / 100);
    line.line_total = r2(taxable + line.cgst_amount + line.sgst_amount + line.igst_amount + line.cess_amount);
    return line;
  });

  const sum = (f) => r2(lines.reduce((s, l) => s + l[f], 0));
  const totals = {
    taxable_value: sum('taxable_value'),
    cgst_amount: sum('cgst_amount'),
    sgst_amount: sum('sgst_amount'),
    igst_amount: sum('igst_amount'),
    cess_amount: sum('cess_amount'),
  };
  const tax = r2(totals.cgst_amount + totals.sgst_amount + totals.igst_amount + totals.cess_amount);
  const beforeRound = supply.reverseCharge ? totals.taxable_value : r2(totals.taxable_value + tax);
  const total = roundOff ? Math.round(beforeRound) : beforeRound;
  totals.round_off = r2(total - beforeRound);
  totals.total_amount = r2(total);
  totals.tax_amount = tax;
  if (totals.total_amount <= 0) throw httpError(400, 'Voucher total must be greater than zero');
  return { lines, totals };
}

function isGoods(line) {
  return !line.hsn_sac || !line.hsn_sac.startsWith('99');
}

module.exports = { determineSupply, computeLines, isGoods };
