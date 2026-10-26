/**
 * Voucher numbering — series per company + voucher type (optionally per branch), effective-dated
 * format, counter per financial year.
 */
const pool = require('../../config/db');
const { httpError, today, parseDate, cleanText, isTruthy } = require('../common');
const {
  loadVersions, resolveVersion, insertFirstVersion, saveVersion, cancelLatestScheduled,
} = require('../versioning');
const { readFields, changedKeys, pick, dbRow, outFields } = require('../party/fields');
const { assertCompanyUsable } = require('../party/access');
const { NUMBERED_VOUCHER_TYPES, sideForVoucherType } = require('../../config/accountingConfig');
const { requireBooks, ensureFinancialYear } = require('./books');
const {
  writeLog, diff, withTransaction, requireCompanyId,
} = require('./common');

const AUDIT = 'accounting_audit_logs';
const GST_DOC_NO_RE = /^[A-Za-z0-9/-]{1,16}$/;
const TOKENS = ['{FY}', '{FYFULL}', '{YYYY}', '{YY}', '{MM}', '{SEQ}'];

const SERIES_FIELDS = {
  format: { type: 'text', max: 60, required: true },
  padding: { type: 'int', min: 1, maxValue: 10, default: 4 },
  status: { type: 'enum', values: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
};

function isGstDoc(voucherType) {
  return !!sideForVoucherType(voucherType)?.voucherTypes[voucherType]?.gstDoc;
}

function validateFormat(format) {
  if (!format.includes('{SEQ}')) throw httpError(400, 'format must contain {SEQ}');
  const unknown = (format.match(/\{[A-Z]+\}/g) || []).filter((t) => !TOKENS.includes(t));
  if (unknown.length) throw httpError(400, `Unknown token ${unknown[0]} — allowed: ${TOKENS.join(' ')}`);
}

/** fy: { code, start_date } */
function formatNumber(format, padding, seq, fy, date) {
  const [yyyy, mm] = date.split('-');
  const fyShort = fy.code.includes('-') ? `${fy.code.slice(2, 4)}-${fy.code.slice(5)}` : fy.code.slice(2);
  return format
    .replace('{FYFULL}', fy.code)
    .replace('{FY}', fyShort)
    .replace('{YYYY}', yyyy)
    .replace('{YY}', yyyy.slice(2))
    .replace('{MM}', mm)
    .replace('{SEQ}', String(seq).padStart(padding, '0'));
}

function assertNumberAllowed(voucherType, voucherNo) {
  if (voucherNo.length > 50) throw httpError(400, `Voucher number ${voucherNo} is longer than 50 characters`);
  if (isGstDoc(voucherType) && !GST_DOC_NO_RE.test(voucherNo)) {
    throw httpError(400, `GST document number ${voucherNo} must be at most 16 characters of letters, digits, / and - — shorten the series format`);
  }
}

async function seedSeries(conn, companyId, effectiveDate, actor) {
  for (const { type, format } of NUMBERED_VOUCHER_TYPES) {
    const [ins] = await conn.query(
      'INSERT INTO voucher_series (company_id, voucher_type, name, is_default, created_by) VALUES (?, ?, ?, 1, ?)',
      [companyId, type, 'Default', actor]
    );
    await insertFirstVersion(conn, {
      table: 'voucher_series_versions', fk: 'series_id', parentId: ins.insertId, fields: ['format', 'padding', 'status'],
      data: { format, padding: 4, status: 'ACTIVE' }, effectiveDate, remarks: 'Default numbering', actor,
    });
  }
}

/**
 * Next number for a voucher (inside the caller's transaction).
 * Picks the given series, else the default series of the branch, else the company default.
 */
async function nextVoucherNumber(conn, { companyId, voucherType, seriesId, branchId, fy, date, table }) {
  let series;
  if (seriesId) {
    [[series]] = await conn.query('SELECT * FROM voucher_series WHERE id = ? AND company_id = ? AND voucher_type = ?', [Number(seriesId), companyId, voucherType]);
    if (!series) throw httpError(400, `series_id ${seriesId} is not a ${voucherType} series of this company`);
    if (series.branch_id && branchId && series.branch_id !== Number(branchId)) throw httpError(400, 'Series belongs to another branch');
  } else {
    [[series]] = await conn.query(
      `SELECT * FROM voucher_series WHERE company_id = ? AND voucher_type = ? AND is_default = 1
         AND (branch_id = ? OR branch_id IS NULL)
       ORDER BY branch_id IS NULL, id LIMIT 1`,
      [companyId, voucherType, branchId || 0]
    );
    if (!series) throw httpError(400, `No default numbering series for ${voucherType}`);
  }
  const versions = (await loadVersions(conn, 'voucher_series_versions', 'series_id', [series.id])).get(series.id) || [];
  const { current } = resolveVersion(versions, date);
  if (!current || current.status !== 'ACTIVE') throw httpError(400, `Numbering series ${series.name} is not active on ${date}`);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    await conn.query(
      `INSERT INTO voucher_counters (series_id, financial_year_id, last_number) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
      [series.id, fy.id]
    );
    const [[{ last_number: seq }]] = await conn.query(
      'SELECT last_number FROM voucher_counters WHERE series_id = ? AND financial_year_id = ?',
      [series.id, fy.id]
    );
    const voucherNo = formatNumber(current.format, current.padding, seq, fy, date);
    assertNumberAllowed(voucherType, voucherNo);
    const [taken] = await conn.query(
      `SELECT id FROM ${table} WHERE company_id = ? AND voucher_type = ? AND financial_year_id = ? AND voucher_no = ?`,
      [companyId, voucherType, fy.id, voucherNo]
    );
    if (!taken.length) return { seriesId: series.id, voucherNo };
  }
  throw httpError(500, 'Could not allocate a voucher number');
}

// ---------- API ----------

async function loadSeries(conn, ctx, id) {
  const [[series]] = await conn.query('SELECT * FROM voucher_series WHERE id = ?', [Number(id) || 0]);
  if (!series || !ctx.canSeeCompany(series.company_id)) throw httpError(404, 'Numbering series not found');
  return series;
}

function formatSeries(series, versions, asOf, counters = []) {
  const { current, upcoming } = resolveVersion(versions, asOf);
  const v = current || upcoming;
  return {
    id: series.id, company_id: series.company_id, voucher_type: series.voucher_type, name: series.name,
    branch_id: series.branch_id, is_default: !!series.is_default,
    ...(v ? { version_id: v.id, ...outFields(SERIES_FIELDS, v), effective_from: v.effective_from } : {}),
    upcoming_change: current && upcoming ? { version_id: upcoming.id, format: upcoming.format, effective_from: upcoming.effective_from } : null,
    counters,
    history: versions.map((x) => ({
      version_id: x.id, ...outFields(SERIES_FIELDS, x), effective_from: x.effective_from, effective_to: x.effective_to,
      remarks: x.remarks, created_by: x.created_by,
    })).reverse(),
  };
}

async function listSeries(ctx, query = {}) {
  ctx.assert('view');
  const companyId = requireCompanyId(query.company_id);
  await assertCompanyUsable(ctx, companyId);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const params = [companyId];
  let sql = 'SELECT * FROM voucher_series WHERE company_id = ?';
  if (cleanText(query.voucher_type)) { sql += ' AND voucher_type = ?'; params.push(String(query.voucher_type).toUpperCase()); }
  const [rows] = await pool.query(`${sql} ORDER BY voucher_type, is_default DESC, name`, params);
  const versions = await loadVersions(pool, 'voucher_series_versions', 'series_id', rows.map((r) => r.id));
  const [counters] = rows.length
    ? await pool.query(
      `SELECT c.series_id, f.code AS financial_year, c.last_number FROM voucher_counters c
       JOIN financial_years f ON f.id = c.financial_year_id WHERE c.series_id IN (?) ORDER BY f.start_date`,
      [rows.map((r) => r.id)]
    )
    : [[]];
  return rows.map((s) => formatSeries(s, versions.get(s.id) || [], asOf,
    counters.filter((c) => c.series_id === s.id).map(({ financial_year, last_number }) => ({ financial_year, last_number }))));
}

async function getSeries(ctx, id, query = {}) {
  ctx.assert('view');
  const series = await loadSeries(pool, ctx, id);
  const list = await listSeries(ctx, { company_id: series.company_id, voucher_type: series.voucher_type, as_of: query.as_of });
  return list.find((s) => s.id === series.id);
}

async function setDefault(conn, series) {
  await conn.query(
    'UPDATE voucher_series SET is_default = 0 WHERE company_id = ? AND voucher_type = ? AND (branch_id <=> ?) AND id <> ?',
    [series.company_id, series.voucher_type, series.branch_id, series.id]
  );
  await conn.query('UPDATE voucher_series SET is_default = 1 WHERE id = ?', [series.id]);
}

async function createSeries(ctx, body = {}) {
  ctx.assert('manage');
  const companyId = requireCompanyId(body.company_id);
  await assertCompanyUsable(ctx, companyId);
  const voucherType = cleanText(body.voucher_type)?.toUpperCase();
  if (!NUMBERED_VOUCHER_TYPES.some((t) => t.type === voucherType)) {
    throw httpError(400, `voucher_type must be one of ${NUMBERED_VOUCHER_TYPES.map((t) => t.type).join(', ')}`);
  }
  const name = cleanText(body.name);
  if (!name) throw httpError(400, 'name is required');
  const data = readFields(SERIES_FIELDS, body);
  validateFormat(data.format);
  const reason = cleanText(body.reason) ?? null;
  const id = await withTransaction(async (conn) => {
    const books = await requireBooks(conn, companyId);
    const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
    if (effectiveDate < books.books_start_date) throw httpError(400, `effective_date cannot be before the books start date ${books.books_start_date}`);
    const branchId = body.branch_id ? Number(body.branch_id) : null;
    if (branchId) {
      const [[b]] = await conn.query('SELECT id FROM branches WHERE id = ? AND company_id = ?', [branchId, companyId]);
      if (!b) throw httpError(400, 'branch_id does not belong to this company');
    }
    const fy = await ensureFinancialYear(conn, companyId, effectiveDate, ctx.actor);
    assertNumberAllowed(voucherType, formatNumber(data.format, data.padding, 1, fy, effectiveDate));
    const [dup] = await conn.query('SELECT id FROM voucher_series WHERE company_id = ? AND voucher_type = ? AND name = ?', [companyId, voucherType, name]);
    if (dup.length) throw httpError(409, `Series ${name} already exists for ${voucherType}`);
    const [ins] = await conn.query(
      'INSERT INTO voucher_series (company_id, voucher_type, name, branch_id, created_by) VALUES (?, ?, ?, ?, ?)',
      [companyId, voucherType, name, branchId, ctx.actor]
    );
    await insertFirstVersion(conn, {
      table: 'voucher_series_versions', fk: 'series_id', parentId: ins.insertId, fields: Object.keys(SERIES_FIELDS),
      data: dbRow(SERIES_FIELDS, data), effectiveDate, remarks: reason, actor: ctx.actor,
    });
    if (isTruthy(body.is_default)) await setDefault(conn, { id: ins.insertId, company_id: companyId, voucher_type: voucherType, branch_id: branchId });
    await writeLog(conn, AUDIT, {
      companyId, entityType: 'SERIES', entityId: ins.insertId, action: 'CREATED', effectiveDate, reason, actor: ctx.actor, role: ctx.role,
    }, [{ field: 'voucher_type', old: null, new: voucherType }, { field: 'name', old: null, new: name },
      ...diff({}, data, Object.keys(SERIES_FIELDS))]);
    return ins.insertId;
  });
  return getSeries(ctx, id);
}

async function updateSeries(ctx, id, body = {}) {
  ctx.assert('manage');
  const series = await loadSeries(pool, ctx, id);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const reason = cleanText(body.reason) ?? null;
  await withTransaction(async (conn) => {
    const versions = (await loadVersions(conn, 'voucher_series_versions', 'series_id', [series.id])).get(series.id) || [];
    const latest = versions[versions.length - 1];
    const changes = readFields(SERIES_FIELDS, body, { partial: true });
    const changed = changedKeys(SERIES_FIELDS, changes, latest);
    const makeDefault = isTruthy(body.is_default) && !series.is_default;
    if (!changed.length && !makeDefault) throw httpError(400, 'No changes to save');
    if (changed.length) {
      const merged = { ...pick(SERIES_FIELDS, latest), ...changes };
      validateFormat(merged.format);
      const fy = await ensureFinancialYear(conn, series.company_id, effectiveDate, ctx.actor);
      assertNumberAllowed(series.voucher_type, formatNumber(merged.format, merged.padding, 1, fy, effectiveDate));
      if (merged.status !== 'ACTIVE' && series.is_default) throw httpError(400, 'Make another series the default before deactivating this one');
      const { mode } = await saveVersion(conn, {
        table: 'voucher_series_versions', fk: 'series_id', parentId: series.id, latest, fields: Object.keys(SERIES_FIELDS),
        data: dbRow(SERIES_FIELDS, merged), effectiveDate, remarks: reason, actor: ctx.actor,
      });
      await writeLog(conn, AUDIT, {
        companyId: series.company_id, entityType: 'SERIES', entityId: series.id, action: mode === 'CORRECTED' ? 'CORRECTED' : 'UPDATED',
        effectiveDate, reason, actor: ctx.actor, role: ctx.role,
      }, diff(latest, merged, changed));
    }
    if (makeDefault) {
      await setDefault(conn, series);
      await writeLog(conn, AUDIT, {
        companyId: series.company_id, entityType: 'SERIES', entityId: series.id, action: 'DEFAULT_CHANGED',
        effectiveDate: today(), reason, actor: ctx.actor, role: ctx.role,
      }, [{ field: 'is_default', old: 'false', new: 'true' }]);
    }
  });
  return getSeries(ctx, series.id, { as_of: effectiveDate });
}

async function cancelSeriesVersion(ctx, id, versionId) {
  ctx.assert('manage');
  const series = await loadSeries(pool, ctx, id);
  await withTransaction(async (conn) => {
    const { cancelled } = await cancelLatestScheduled(conn, { table: 'voucher_series_versions', fk: 'series_id', parentId: series.id, versionId });
    await writeLog(conn, AUDIT, {
      companyId: series.company_id, entityType: 'SERIES', entityId: series.id, action: 'SCHEDULE_CANCELLED',
      effectiveDate: cancelled.effective_from, actor: ctx.actor, role: ctx.role, note: `version ${cancelled.id}`,
    });
  });
  return getSeries(ctx, series.id);
}

/** Next number that would be issued on `date` (does not consume it). */
async function previewSeries(ctx, id, query = {}) {
  ctx.assert('view');
  const series = await loadSeries(pool, ctx, id);
  const date = parseDate(query.date, 'date') || today();
  const versions = (await loadVersions(pool, 'voucher_series_versions', 'series_id', [series.id])).get(series.id) || [];
  const { current } = resolveVersion(versions, date);
  if (!current) throw httpError(400, `Series is not effective on ${date}`);
  const [[fy]] = await pool.query('SELECT * FROM financial_years WHERE company_id = ? AND ? BETWEEN start_date AND end_date', [series.company_id, date]);
  if (!fy) throw httpError(400, `No financial year for ${date}`);
  const [[counter]] = await pool.query('SELECT last_number FROM voucher_counters WHERE series_id = ? AND financial_year_id = ?', [series.id, fy.id]);
  return { date, financial_year: fy.code, next_number: formatNumber(current.format, current.padding, (counter?.last_number || 0) + 1, fy, date) };
}

module.exports = {
  SERIES_FIELDS,
  TOKENS,
  seedSeries,
  nextVoucherNumber,
  listSeries,
  getSeries,
  createSeries,
  updateSeries,
  cancelSeriesVersion,
  previewSeries,
};
