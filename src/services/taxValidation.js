const { httpError } = require('./common');
const { normalizeState } = require('./locationService');

/** GST state codes (25 / 28 are legacy codes still found on older registrations). */
const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal', 20: 'Jharkhand',
  21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  25: 'Dadra and Nagar Haveli and Daman and Diu', 26: 'Dadra and Nagar Haveli and Daman and Diu',
  27: 'Maharashtra', 28: 'Andhra Pradesh', 29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep',
  32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands',
  36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh', 96: 'Other Country', 97: 'Other Territory',
};
const LEGACY_CODES = new Set(['25', '28']);

const GST_REGISTRATION_TYPES = [
  'REGULAR', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'OVERSEAS', 'SEZ', 'DEEMED_EXPORT', 'UIN_HOLDER',
];
/** Registration types that must / must not carry a GSTIN. */
const GSTIN_REQUIRED_TYPES = ['REGULAR', 'COMPOSITION', 'SEZ', 'DEEMED_EXPORT', 'UIN_HOLDER'];
const GSTIN_FORBIDDEN_TYPES = ['UNREGISTERED', 'CONSUMER', 'OVERSEAS'];

const TAX_TREATMENTS = [
  'TAXABLE', 'EXEMPT', 'NIL_RATED', 'NON_GST', 'SEZ_WITH_PAYMENT', 'SEZ_WITHOUT_PAYMENT',
  'EXPORT_WITH_PAYMENT', 'EXPORT_WITHOUT_PAYMENT', 'DEEMED_EXPORT',
];

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const MOBILE_RE = /^[6-9][0-9]{9}$/;
const PINCODE_RE = /^[1-9][0-9]{5}$/;
const ACCOUNT_NO_RE = /^[0-9A-Z]{6,20}$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

function normalizeGstin(value, field = 'gstin') {
  if (value == null || value === '') return null;
  const gstin = String(value).replace(/\s+/g, '').toUpperCase();
  if (!GSTIN_RE.test(gstin)) throw httpError(400, `${field} format is invalid (15 characters, e.g. 24AAACJ1234F1Z7)`);
  if (!GST_STATE_CODES[gstin.slice(0, 2)]) throw httpError(400, `${field} has an unknown state code ${gstin.slice(0, 2)}`);
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) throw httpError(400, `${field} checksum digit is invalid`);
  return gstin;
}

function normalizePan(value, field = 'pan') {
  if (value == null || value === '') return null;
  const pan = String(value).replace(/\s+/g, '').toUpperCase();
  if (!PAN_RE.test(pan)) throw httpError(400, `${field} format is invalid (e.g. AAACJ1234F)`);
  return pan;
}

function normalizeStateCode(value, field = 'state_code') {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const code = /^[0-9]{1,2}$/.test(raw) ? raw.padStart(2, '0') : stateCodeForName(raw);
  if (!code || !GST_STATE_CODES[code]) throw httpError(400, `${field} must be a GST state code (e.g. 24) or Indian state name`);
  return code;
}

function stateCodeForName(name) {
  const state = normalizeState(name);
  if (!state) return null;
  return Object.keys(GST_STATE_CODES).find((c) => !LEGACY_CODES.has(c) && GST_STATE_CODES[c] === state) || null;
}

function stateNameForCode(code) {
  return code ? GST_STATE_CODES[code] || null : null;
}

function normalizeIfsc(value, field = 'ifsc') {
  if (value == null || value === '') return null;
  const ifsc = String(value).replace(/\s+/g, '').toUpperCase();
  if (!IFSC_RE.test(ifsc)) throw httpError(400, `${field} format is invalid (e.g. HDFC0001234)`);
  return ifsc;
}

function normalizeUpi(value, field = 'upi_id') {
  if (value == null || value === '') return null;
  const upi = String(value).trim().toLowerCase();
  if (!UPI_RE.test(upi)) throw httpError(400, `${field} format is invalid (e.g. name@okhdfcbank)`);
  return upi;
}

function normalizeMobile(value, field = 'mobile') {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/[\s\-()]/g, '').replace(/^(\+91|0091|91(?=[6-9][0-9]{9}$)|0(?=[6-9][0-9]{9}$))/, '');
  if (!MOBILE_RE.test(digits)) throw httpError(400, `${field} must be a valid 10-digit Indian mobile number`);
  return digits;
}

function normalizePincode(value, field = 'pincode') {
  if (value == null || value === '') return null;
  const pin = String(value).replace(/\s+/g, '');
  if (!PINCODE_RE.test(pin)) throw httpError(400, `${field} must be a 6-digit Indian pincode`);
  return pin;
}

function normalizeAccountNumber(value, field = 'account_number') {
  if (value == null || value === '') return null;
  const acc = String(value).replace(/[\s-]/g, '').toUpperCase();
  if (!ACCOUNT_NO_RE.test(acc)) throw httpError(400, `${field} must be 6-20 letters/digits`);
  return acc;
}

/**
 * Cross-field GST rules for one registration:
 *  - GSTIN required / forbidden by registration type
 *  - GSTIN state code must equal state_code (state_code is derived from GSTIN when missing)
 *  - PAN inside GSTIN (chars 3-12) must equal PAN (PAN is derived from GSTIN when missing)
 */
function validateGstConsistency(data, { panField = 'pan', label = '' } = {}) {
  const prefix = label ? `${label}: ` : '';
  const type = data.gst_registration_type ?? data.registration_type;
  const typeField = data.gst_registration_type !== undefined ? 'gst_registration_type' : 'registration_type';
  if (type && GSTIN_REQUIRED_TYPES.includes(type) && !data.gstin) {
    throw httpError(400, `${prefix}gstin is required for ${typeField} ${type}`);
  }
  if (type && GSTIN_FORBIDDEN_TYPES.includes(type) && data.gstin) {
    throw httpError(400, `${prefix}gstin must be empty for ${typeField} ${type}`);
  }
  if (!data.gstin) return data;

  const gstState = data.gstin.slice(0, 2);
  if (!data.state_code) data.state_code = gstState;
  else if (data.state_code !== gstState && !(LEGACY_CODES.has(gstState) && stateNameForCode(gstState) === stateNameForCode(data.state_code))) {
    throw httpError(400, `${prefix}state_code ${data.state_code} does not match GSTIN state code ${gstState}`);
  }
  const gstPan = data.gstin.slice(2, 12);
  if (panField in data) {
    if (!data[panField]) data[panField] = gstPan;
    else if (data[panField] !== gstPan) throw httpError(400, `${prefix}PAN ${data[panField]} does not match PAN inside GSTIN (${gstPan})`);
  }
  return data;
}

module.exports = {
  GST_STATE_CODES,
  GST_REGISTRATION_TYPES,
  TAX_TREATMENTS,
  gstinCheckChar,
  normalizeGstin,
  normalizePan,
  normalizeStateCode,
  stateCodeForName,
  stateNameForCode,
  normalizeIfsc,
  normalizeUpi,
  normalizeMobile,
  normalizePincode,
  normalizeAccountNumber,
  validateGstConsistency,
};
