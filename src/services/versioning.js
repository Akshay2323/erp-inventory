/**
 * Effective-date versioning shared by master tables (companies, branches, ...).
 *
 * Each master has an identity table plus a <name>_versions table with
 * effective_from / effective_to (NULL = open-ended).
 *
 * Company / branch form edit uses updateLatestVersion:
 *  - updates the latest row's fields AND effective_from (so list API shows the new date)
 *  - removes other versions that would start on/after that date
 *  - previous version ends the day before
 *
 * saveVersion keeps mid-timeline inserts for accounting / party history.
 */
const pool = require('../config/db');
const { httpError, today, addDays } = require('./common');

async function loadVersions(conn, table, fk, parentIds) {
  const map = new Map();
  if (!parentIds.length) return map;
  const [rows] = await conn.query(
    `SELECT * FROM ${table} WHERE ${fk} IN (?) ORDER BY ${fk}, effective_from`,
    [parentIds]
  );
  for (const row of rows) {
    if (!map.has(row[fk])) map.set(row[fk], []);
    map.get(row[fk]).push(row);
  }
  return map;
}

/** versions must be sorted by effective_from ascending */
function resolveVersion(versions, asOf) {
  let current = null;
  for (const v of versions) if (v.effective_from <= asOf) current = v;
  const upcoming = versions.find((v) => v.effective_from > asOf) || null;
  return { current, upcoming };
}

/** Fields of `changes` whose value differs from `latest`. */
function changedFields(changes, latest) {
  return Object.keys(changes).filter((k) => String(changes[k] ?? '') !== String(latest[k] ?? ''));
}

/** @deprecated kept for callers — any date is allowed now. */
function assertEffectiveDate() {
  // no-op: back-dated and mid-timeline effective dates are supported
}

/** `extra` = additional columns stored with the version (e.g. { approval_id }). Returns the new row id. */
async function insertFirstVersion(conn, {
  table, fk, parentId, fields, data, effectiveDate, remarks, actor, extra = {}, effectiveTo = null,
}) {
  const extraCols = Object.keys(extra);
  const [result] = await conn.query(
    `INSERT INTO ${table} (${fk}, ${[...fields, ...extraCols].join(', ')}, effective_from, effective_to, remarks, created_by)
     VALUES (?, ${[...fields, ...extraCols].map(() => '?').join(', ')}, ?, ?, ?, ?)`,
    [
      parentId, ...fields.map((f) => data[f] ?? null), ...Object.values(extra),
      effectiveDate, effectiveTo, remarks ?? null, actor,
    ]
  );
  return result.insertId;
}

/**
 * Save a version on any effective_date.
 * Returns { mode: 'CORRECTED' | 'NEW_VERSION', versionId }.
 */
async function saveVersion(conn, {
  table, fk, parentId, latest, fields, data, effectiveDate, remarks, actor, extra = {},
}) {
  const versions = (await loadVersions(conn, table, fk, [parentId])).get(parentId) || [];
  const chain = versions.length ? versions : (latest ? [latest] : []);
  if (!chain.length) throw httpError(500, 'No version history to update');

  const values = fields.map((f) => data[f] ?? null);
  const extraCols = Object.keys(extra);
  const asDate = (v) => String(v).slice(0, 10);
  const exact = chain.find((v) => asDate(v.effective_from) === effectiveDate);

  if (exact) {
    await conn.query(
      `UPDATE ${table}
       SET ${[...fields, ...extraCols].map((f) => `${f} = ?`).join(', ')}, remarks = ?, created_by = ?
       WHERE id = ?`,
      [...values, ...Object.values(extra), remarks ?? exact.remarks, actor, exact.id]
    );
    return { mode: 'CORRECTED', versionId: exact.id };
  }

  const prev = [...chain].reverse().find((v) => asDate(v.effective_from) < effectiveDate) || null;
  const next = chain.find((v) => asDate(v.effective_from) > effectiveDate) || null;

  if (prev) {
    await conn.query(`UPDATE ${table} SET effective_to = ? WHERE id = ?`, [
      addDays(effectiveDate, -1),
      prev.id,
    ]);
  }

  const effectiveTo = next ? addDays(next.effective_from, -1) : null;
  const versionId = await insertFirstVersion(conn, {
    table, fk, parentId, fields, data, effectiveDate, effectiveTo, remarks, actor, extra,
  });
  return { mode: 'NEW_VERSION', versionId };
}

/**
 * Form edit: move/update the latest version so list (latest) shows the new effective_from.
 * Returns { mode: 'UPDATED_LATEST', versionId }.
 */
async function updateLatestVersion(conn, {
  table, fk, parentId, fields, data, effectiveDate, remarks, actor, extra = {},
}) {
  const versions = (await loadVersions(conn, table, fk, [parentId])).get(parentId) || [];
  if (!versions.length) throw httpError(500, 'No version history to update');

  const asDate = (v) => String(v).slice(0, 10);
  const latest = versions[versions.length - 1];

  // Drop other versions that start on/after the new date (they would hide/conflict with latest).
  const removeIds = versions
    .filter((v) => v.id !== latest.id && asDate(v.effective_from) >= effectiveDate)
    .map((v) => v.id);
  if (removeIds.length) {
    await conn.query(`DELETE FROM ${table} WHERE id IN (?)`, [removeIds]);
  }

  const remaining = (await loadVersions(conn, table, fk, [parentId])).get(parentId) || [];
  const prev = remaining.filter((v) => v.id !== latest.id).pop() || null;
  if (prev) {
    await conn.query(`UPDATE ${table} SET effective_to = ? WHERE id = ?`, [
      addDays(effectiveDate, -1),
      prev.id,
    ]);
  }

  const values = fields.map((f) => data[f] ?? null);
  const extraCols = Object.keys(extra);
  await conn.query(
    `UPDATE ${table}
     SET ${[...fields, ...extraCols].map((f) => `${f} = ?`).join(', ')},
         effective_from = ?, effective_to = NULL, remarks = ?, created_by = ?
     WHERE id = ?`,
    [
      ...values, ...Object.values(extra),
      effectiveDate, remarks ?? latest.remarks, actor, latest.id,
    ]
  );
  return { mode: 'UPDATED_LATEST', versionId: latest.id };
}

/** Runs inside the caller's transaction. Returns { cancelled, restored } version rows. */
async function cancelLatestScheduled(conn, { table, fk, parentId, versionId }) {
  const versions = (await loadVersions(conn, table, fk, [parentId])).get(parentId) || [];
  const latest = versions[versions.length - 1];

  if (!latest || latest.id !== Number(versionId)) {
    throw httpError(400, 'Only the latest version can be cancelled');
  }
  if (latest.effective_from <= today()) {
    throw httpError(400, 'Version is already effective and cannot be cancelled — add a new version instead');
  }
  if (versions.length < 2) throw httpError(400, 'Cannot cancel the only version');

  const previous = versions[versions.length - 2];
  await conn.query(`DELETE FROM ${table} WHERE id = ?`, [latest.id]);
  await conn.query(`UPDATE ${table} SET effective_to = NULL WHERE id = ?`, [previous.id]);
  return { cancelled: latest, restored: previous };
}

async function cancelScheduledVersion(params) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await cancelLatestScheduled(conn, params);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  loadVersions,
  resolveVersion,
  changedFields,
  assertEffectiveDate,
  insertFirstVersion,
  saveVersion,
  updateLatestVersion,
  cancelLatestScheduled,
  cancelScheduledVersion,
};
