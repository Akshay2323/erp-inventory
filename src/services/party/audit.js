const pool = require('../../config/db');
const { httpError, parseDate, cleanText } = require('../common');

/** Indian financial year (April–March) for a YYYY-MM-DD date, e.g. 2026-10-14 → "2026-27". */
function financialYear(date) {
  if (!date) return null;
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function parseFinancialYear(value) {
  const fy = cleanText(value);
  if (!fy) return null;
  const match = fy.match(/^(\d{4})-(\d{2})$/);
  if (!match || (Number(match[1]) + 1) % 100 !== Number(match[2])) {
    throw httpError(400, 'financial_year must look like 2026-27');
  }
  return fy;
}

function truncate(value, max = 60000) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Appends audit rows (one per changed field, or a single row when `changes` is empty).
 * meta: { companyId, partyId, entityType, entityId, action, effectiveDate, reason, actor, role, approval }
 * approval: { id, status, approved_by, approved_at } — status NOT_REQUIRED when omitted
 */
async function writeAudit(conn, cfg, meta, changes = []) {
  const approval = meta.approval || {};
  const base = [
    meta.companyId,
    meta.partyId,
    meta.entityType,
    meta.entityId ?? null,
    meta.action,
  ];
  const tail = [
    meta.effectiveDate || null,
    financialYear(meta.effectiveDate),
    meta.reason || null,
    meta.actor || null,
    meta.role || null,
    approval.id || null,
    approval.status || 'NOT_REQUIRED',
    approval.approved_by || null,
    approval.approved_at || null,
  ];
  const rows = (changes.length ? changes : [{ field: null, old: null, new: meta.note ?? null }]).map((c) => [
    ...base, c.field, truncate(c.old), truncate(c.new), ...tail,
  ]);
  await conn.query(
    `INSERT INTO ${cfg.auditTable}
       (company_id, ${cfg.fk}, entity_type, entity_id, action, field_name, old_value, new_value,
        effective_date, financial_year, change_reason, changed_by, changed_by_role,
        approval_id, approval_status, approved_by, approved_at)
     VALUES ?`,
    [rows]
  );
}

/** Address / bank history row (old & new snapshot of the whole record). */
async function writeChildHistory(conn, child, cfg, meta) {
  if (!child.historyTable) return;
  await conn.query(
    `INSERT INTO ${child.historyTable}
       (${cfg.fk}, root_id, change_type, old_values, new_values, effective_date, change_reason,
        changed_by, approval_id, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.partyId,
      meta.rootId,
      meta.changeType,
      meta.oldValues ? JSON.stringify(meta.oldValues) : null,
      meta.newValues ? JSON.stringify(meta.newValues) : null,
      meta.effectiveDate || null,
      meta.reason || null,
      meta.actor || null,
      meta.approval?.id || null,
      meta.approval?.approved_by || null,
    ]
  );
}

/** History viewer — filters: party, company, entity_type, entity_id, field, action, user, dates, FY, approval status, text. */
async function listAudit(ctx, query = {}, partyId = null) {
  const { cfg } = ctx;
  const where = [];
  const params = [];
  const scope = ctx.companyFilter('a.company_id');
  where.push(scope.sql);
  params.push(...scope.params);

  const add = (sql, value) => {
    where.push(sql);
    params.push(value);
  };
  if (partyId) add(`a.${cfg.fk} = ?`, Number(partyId));
  else if (cleanText(query[cfg.fk])) add(`a.${cfg.fk} = ?`, Number(query[cfg.fk]));
  if (cleanText(query.company_id)) add('a.company_id = ?', Number(query.company_id));
  if (cleanText(query.entity_type)) add('a.entity_type = ?', String(query.entity_type).toUpperCase());
  if (cleanText(query.entity_id)) add('a.entity_id = ?', Number(query.entity_id));
  if (cleanText(query.field)) add('a.field_name = ?', String(query.field));
  if (cleanText(query.action)) add('a.action = ?', String(query.action).toUpperCase());
  if (cleanText(query.changed_by)) add('a.changed_by LIKE ?', `%${query.changed_by}%`);
  if (cleanText(query.approval_status)) add('a.approval_status = ?', String(query.approval_status).toUpperCase());
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  if (from) add('a.changed_at >= ?', `${from} 00:00:00`);
  if (to) add('a.changed_at <= ?', `${to} 23:59:59`);
  const effFrom = parseDate(query.effective_from, 'effective_from');
  const effTo = parseDate(query.effective_to, 'effective_to');
  if (effFrom) add('a.effective_date >= ?', effFrom);
  if (effTo) add('a.effective_date <= ?', effTo);
  const fy = parseFinancialYear(query.financial_year);
  if (fy) add('a.financial_year = ?', fy);
  if (cleanText(query.search)) {
    where.push('(a.old_value LIKE ? OR a.new_value LIKE ? OR a.change_reason LIKE ? OR p.code LIKE ?)');
    const like = `%${query.search}%`;
    params.push(like, like, like, like);
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const whereSql = where.join(' AND ');
  const from_ = `FROM ${cfg.auditTable} a JOIN ${cfg.table} p ON p.id = a.${cfg.fk}`;

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from_} WHERE ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT a.*, p.code AS ${cfg.prefix}_code,
            (SELECT v.name FROM ${cfg.versionTable} v WHERE v.${cfg.fk} = a.${cfg.fk}
             ORDER BY v.effective_from DESC LIMIT 1) AS ${cfg.prefix}_name
     ${from_} WHERE ${whereSql}
     ORDER BY a.changed_at DESC, a.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );
  return { data: rows, page, limit, total: Number(total) };
}

module.exports = { financialYear, writeAudit, writeChildHistory, listAudit };
