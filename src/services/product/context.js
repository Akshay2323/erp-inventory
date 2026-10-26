/** Shared product-module context, audit, and field helpers. */
const pool = require('../../config/db');
const {
  httpError, today, parseDate, cleanText, parseBool,
} = require('../common');
const { buildPartyContext, assertCompanyUsable } = require('../party/access');

const MODULE = { key: 'products', label: 'Product' };
const AUDIT = 'product_audit_logs';

async function moduleContext(user, authSource) {
  return buildPartyContext(MODULE, user, authSource);
}

async function writeAudit(conn, meta, changes = []) {
  const rows = changes.length ? changes : [{ field: null, old: null, new: null }];
  await conn.query(
    `INSERT INTO ${AUDIT}
     (company_id, product_id, entity_type, entity_id, action, field_name, old_value, new_value,
      effective_date, change_reason, changed_by, changed_by_role, note)
     VALUES ?`,
    [rows.map((c) => [
      meta.companyId, meta.productId || null, meta.entityType, meta.entityId || null, meta.action,
      c.field, c.old != null ? String(c.old).slice(0, 60000) : null,
      c.new != null ? String(c.new).slice(0, 60000) : null,
      meta.effectiveDate || null, meta.reason || null, meta.actor, meta.role || null, meta.note || null,
    ])]
  );
}

async function loadProduct(conn, ctx, id) {
  const [[row]] = await conn.query('SELECT * FROM products WHERE id = ?', [Number(id) || 0]);
  if (!row || !ctx.canSeeCompany(row.company_id)) throw httpError(404, 'Product not found');
  return row;
}

function parseJson(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { throw httpError(400, `${field} must be valid JSON`); }
}

function readVersionFields(specs, body, { partial = false } = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (body[name] === undefined) {
      if (!partial && spec.required) throw httpError(400, `${name} is required`);
      if (!partial && spec.default !== undefined) out[name] = spec.default;
      continue;
    }
    if (spec.type === 'bool') out[name] = parseBool(body[name], name) ? 1 : 0;
    else if (spec.type === 'enum') {
      let v = cleanText(body[name]);
      if (v != null && spec.values.every((x) => typeof x === 'string' && Number.isNaN(Number(x)))) {
        v = v.toUpperCase();
      }
      if (v != null && !spec.values.map(String).includes(String(v))) {
        throw httpError(400, `${name} must be one of ${spec.values.join(', ')}`);
      }
      out[name] = v ?? null;
    } else if (spec.type === 'int') {
      if (body[name] === null || body[name] === '') out[name] = null;
      else {
        const n = Number(body[name]);
        if (!Number.isInteger(n)) throw httpError(400, `${name} must be an integer`);
        out[name] = n;
      }
    } else if (spec.type === 'json') out[name] = parseJson(body[name], name);
    else {
      const t = cleanText(body[name]);
      if (t && spec.max && t.length > spec.max) throw httpError(400, `${name} must be at most ${spec.max} characters`);
      out[name] = t ?? null;
    }
  }
  return out;
}

function dbRow(fields, data) {
  return Object.fromEntries(fields.map((f) => {
    const v = data[f];
    if (v !== null && typeof v === 'object') return [f, JSON.stringify(v)];
    return [f, v ?? null];
  }));
}

function formatVersion(specs, row) {
  if (!row) return null;
  const out = {
    version_id: row.id,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    remarks: row.remarks,
    created_by: row.created_by,
  };
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.type === 'bool') out[name] = !!row[name];
    else if (spec.type === 'json') {
      const v = row[name];
      out[name] = typeof v === 'string' ? JSON.parse(v) : v;
    } else out[name] = row[name] ?? null;
  }
  return out;
}

async function resolveUom(conn, uomId, companyId) {
  if (!uomId) return null;
  const [[u]] = await conn.query(
    `SELECT * FROM units_of_measure
     WHERE id = ? AND status = 'ACTIVE' AND (company_id IS NULL OR company_id = ?)`,
    [uomId, companyId]
  );
  if (!u) throw httpError(400, `Invalid uom_id ${uomId}`);
  return u;
}

module.exports = {
  MODULE,
  AUDIT,
  pool,
  moduleContext,
  writeAudit,
  loadProduct,
  assertCompanyUsable,
  httpError,
  today,
  parseDate,
  cleanText,
  parseBool,
  parseJson,
  readVersionFields,
  dbRow,
  formatVersion,
  resolveUom,
};
