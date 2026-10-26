const pool = require('../../config/db');
const { httpError, parseDate, cleanText } = require('../common');
const { buildPartyContext } = require('../party/access');
const { financialYear } = require('../party/audit');

/** Per-request context for an accounting module key: 'accounting', or a side config (sales / purchases). */
function moduleContext(cfgOrKey, user, authSource) {
  const cfg = typeof cfgOrKey === 'string' ? { key: cfgOrKey } : cfgOrKey;
  return buildPartyContext(cfg, user, authSource);
}

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const opposite = (effect) => (effect === 'DR' ? 'CR' : 'DR');
const money = (n) => r2(n).toFixed(2);

function truncate(value, max = 60000) {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Appends audit rows to an append-only log table.
 * meta: { companyId, entityType, entityId, action, effectiveDate, fyCode, reason, actor, role, note,
 *         voucherId, partyFk, partyId }  (voucher / party columns only for sales_* / purchase_* logs)
 */
async function writeLog(conn, table, meta, changes = []) {
  const sideCols = meta.partyFk ? ['voucher_id', meta.partyFk] : [];
  const cols = [
    'company_id', ...sideCols, 'entity_type', 'entity_id', 'action', 'field_name', 'old_value', 'new_value',
    'effective_date', 'financial_year', 'change_reason', 'changed_by', 'changed_by_role',
  ];
  const list = changes.length ? changes : [{ field: null, old: null, new: meta.note ?? null }];
  const rows = list.map((c) => [
    meta.companyId,
    ...(meta.partyFk ? [meta.voucherId ?? null, meta.partyId ?? null] : []),
    meta.entityType,
    meta.entityId ?? null,
    meta.action,
    c.field,
    truncate(c.old),
    truncate(c.new),
    meta.effectiveDate || null,
    meta.fyCode || financialYear(meta.effectiveDate),
    meta.reason || null,
    meta.actor || null,
    meta.role || null,
  ]);
  await conn.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ?`, [rows]);
}

/** Field-level diff for audit: [{field, old, new}] for keys whose value changed. */
function diff(oldRow, newRow, fields) {
  const norm = (v) => {
    if (v === null || v === undefined || v === '') return null;
    return typeof v === 'number' || /^-?\d+\.\d+$/.test(v) ? String(Number(v)) : String(v);
  };
  return fields
    .filter((f) => norm(oldRow?.[f]) !== norm(newRow?.[f]))
    .map((f) => ({ field: f, old: norm(oldRow?.[f]), new: norm(newRow?.[f]) }));
}

async function listLogs(ctx, table, query = {}, { partyFk = null } = {}) {
  const scope = ctx.companyFilter('a.company_id');
  const where = [scope.sql];
  const params = [...scope.params];
  const add = (sql, v) => { where.push(sql); params.push(v); };
  if (cleanText(query.company_id)) add('a.company_id = ?', Number(query.company_id));
  if (cleanText(query.entity_type)) add('a.entity_type = ?', String(query.entity_type).toUpperCase());
  if (cleanText(query.entity_id)) add('a.entity_id = ?', Number(query.entity_id));
  if (cleanText(query.action)) add('a.action = ?', String(query.action).toUpperCase());
  if (cleanText(query.field)) add('a.field_name = ?', String(query.field));
  if (cleanText(query.changed_by)) add('a.changed_by LIKE ?', `%${query.changed_by}%`);
  if (cleanText(query.financial_year)) add('a.financial_year = ?', String(query.financial_year));
  if (partyFk) {
    if (cleanText(query.voucher_id)) add('a.voucher_id = ?', Number(query.voucher_id));
    if (cleanText(query[partyFk])) add(`a.${partyFk} = ?`, Number(query[partyFk]));
  }
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  if (from) add('a.changed_at >= ?', `${from} 00:00:00`);
  if (to) add('a.changed_at <= ?', `${to} 23:59:59`);

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const whereSql = where.join(' AND ');
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${table} a WHERE ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT a.* FROM ${table} a WHERE ${whereSql} ORDER BY a.changed_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );
  return { data: rows, page, limit, total: Number(total) };
}

function requireCompanyId(value) {
  const id = Number(value);
  if (!id) throw httpError(400, 'company_id is required');
  return id;
}

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  moduleContext, r2, opposite, money, writeLog, diff, listLogs, requireCompanyId, withTransaction,
};
