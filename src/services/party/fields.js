/** Spec-driven input normalisation, change detection and output formatting. */
const { EMAIL_RE, httpError, parseDate, cleanText } = require('../common');
const { normalizeState } = require('../locationService');
const tax = require('../taxValidation');

const FALSE_VALUES = [false, 0, '0', 'false', 'no', 'off'];
const TRUE_VALUES = [true, 1, '1', 'true', 'yes', 'on'];

function normalizeValue(spec, raw, field) {
  if (raw === undefined) return undefined;
  if (spec.type === 'bool') {
    if (raw === null || raw === '') return 0;
    if (TRUE_VALUES.includes(raw)) return 1;
    if (FALSE_VALUES.includes(raw)) return 0;
    throw httpError(400, `${field} must be true or false`);
  }
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;

  switch (spec.type) {
    case 'text': {
      const s = cleanText(raw);
      if (s && s.length > spec.max) throw httpError(400, `${field} must be at most ${spec.max} characters`);
      return s;
    }
    case 'email': {
      const s = String(raw).trim().toLowerCase();
      if (!EMAIL_RE.test(s) || s.length > 255) throw httpError(400, `${field} is not a valid email`);
      return s;
    }
    case 'enum': {
      const s = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (!spec.values.includes(s)) throw httpError(400, `${field} must be one of ${spec.values.join(', ')}`);
      return s;
    }
    case 'mobile': return tax.normalizeMobile(raw, field);
    case 'gstin': return tax.normalizeGstin(raw, field);
    case 'pan': return tax.normalizePan(raw, field);
    case 'state_code': return tax.normalizeStateCode(raw, field);
    case 'pincode': return tax.normalizePincode(raw, field);
    case 'ifsc': return tax.normalizeIfsc(raw, field);
    case 'upi': return tax.normalizeUpi(raw, field);
    case 'account_number': return tax.normalizeAccountNumber(raw, field);
    case 'state': {
      const state = normalizeState(raw);
      if (!state) throw httpError(400, `${field} "${raw}" is not a valid Indian state / UT`);
      return state;
    }
    case 'int':
    case 'user_id': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw httpError(400, `${field} must be a whole number`);
      if (spec.type === 'user_id' && n < 1) throw httpError(400, `${field} must be a positive id`);
      if (spec.min != null && n < spec.min) throw httpError(400, `${field} must be >= ${spec.min}`);
      if (spec.maxValue != null && n > spec.maxValue) throw httpError(400, `${field} must be <= ${spec.maxValue}`);
      return n;
    }
    case 'decimal':
    case 'qty': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw httpError(400, `${field} must be a number`);
      if (spec.min != null && n < spec.min) throw httpError(400, `${field} must be >= ${spec.min}`);
      if (Math.abs(n) >= 1e14) throw httpError(400, `${field} is too large`);
      return n.toFixed(spec.type === 'qty' ? 3 : 2);
    }
    case 'coord': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw httpError(400, `${field} must be a number`);
      return n.toFixed(7);
    }
    case 'date': return parseDate(raw, field);
    case 'json': {
      let value = raw;
      if (typeof raw === 'string') {
        try {
          value = JSON.parse(raw);
        } catch {
          throw httpError(400, `${field} must be valid JSON`);
        }
      }
      if (value === null) return null;
      if (typeof value !== 'object') throw httpError(400, `${field} must be a JSON array or object`);
      if (JSON.stringify(value).length > 20000) throw httpError(400, `${field} is too large`);
      return value;
    }
    default:
      throw httpError(500, `Unknown field type ${spec.type}`);
  }
}

/**
 * Reads fields present in `body` (partial) or all fields with defaults (full).
 * `labelPrefix` is used in error messages, e.g. "addresses[1]."
 */
function readFields(specs, body = {}, { partial = false, labelPrefix = '' } = {}) {
  const out = {};
  for (const [field, spec] of Object.entries(specs)) {
    const value = normalizeValue(spec, body[field], `${labelPrefix}${field}`);
    if (value !== undefined) out[field] = value;
    else if (!partial) out[field] = spec.default ?? (spec.type === 'bool' ? 0 : null);
  }
  return out;
}

function assertRequired(specs, data, labelPrefix = '') {
  for (const [field, spec] of Object.entries(specs)) {
    if (spec.required && (data[field] === null || data[field] === undefined)) {
      throw httpError(400, `${labelPrefix}${field} is required`);
    }
  }
}

/** Comparable string form — DB values (DECIMAL strings, parsed JSON, 0/1) and input values line up. */
function valueKey(spec, value) {
  if (value === null || value === undefined) return spec?.type === 'bool' ? '0' : '';
  switch (spec?.type) {
    case 'json': return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value);
    case 'decimal': return Number(value).toFixed(2);
    case 'qty': return Number(value).toFixed(3);
    case 'coord': return Number(value).toFixed(7);
    case 'bool': return String(Number(value) ? 1 : 0);
    default: return String(value);
  }
}

function changedKeys(specs, changes, current) {
  return Object.keys(changes).filter((k) => valueKey(specs[k], changes[k]) !== valueKey(specs[k], current?.[k]));
}

function pick(specs, row) {
  return Object.fromEntries(Object.keys(specs).map((k) => [k, row?.[k] ?? null]));
}

/** Value for SQL parameters. */
function toDb(spec, value) {
  if (value === undefined || value === null) return spec?.type === 'bool' ? 0 : null;
  if (spec?.type === 'json') return JSON.stringify(value);
  return value;
}

function dbRow(specs, data) {
  return Object.fromEntries(Object.keys(specs).map((k) => [k, toDb(specs[k], data[k])]));
}

/** Value for API responses. */
function outValue(spec, value) {
  if (value === undefined) return null;
  switch (spec?.type) {
    case 'bool': return !!Number(value);
    case 'decimal':
    case 'qty':
    case 'coord':
    case 'int':
    case 'user_id':
      return value === null ? null : Number(value);
    case 'json': return typeof value === 'string' ? JSON.parse(value) : value;
    default: return value;
  }
}

function outFields(specs, row) {
  return Object.fromEntries(Object.keys(specs).map((k) => [k, outValue(specs[k], row?.[k])]));
}

/** Audit text for a value. */
function auditText(spec, value) {
  if (value === null || value === undefined) return null;
  if (spec?.type === 'json') return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value);
  if (spec?.type === 'bool') return Number(value) ? 'true' : 'false';
  return String(value);
}

module.exports = {
  normalizeValue,
  readFields,
  assertRequired,
  valueKey,
  changedKeys,
  pick,
  dbRow,
  outFields,
  outValue,
  auditText,
};
