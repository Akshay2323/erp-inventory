/**
 * Company books: one-time setup, company accounting settings (effective-dated) and financial years.
 */
const pool = require('../../config/db');
const { httpError, today, addDays, parseDate, cleanText } = require('../common');
const {
  loadVersions, resolveVersion, insertFirstVersion, saveVersion, cancelLatestScheduled,
} = require('../versioning');
const { validateGstConsistency } = require('../taxValidation');
const { readFields, changedKeys, pick, dbRow, outFields } = require('../party/fields');
const { assertCompanyUsable } = require('../party/access');
const { writeLog, diff, withTransaction } = require('./common');

const AUDIT = 'accounting_audit_logs';
const SETTINGS_TABLE = 'company_accounting_settings';
const COMPANY_GST_TYPES = ['REGULAR', 'COMPOSITION', 'UNREGISTERED', 'SEZ'];

const SETTINGS_FIELDS = {
  trade_name: { type: 'text', max: 255 },
  gstin: { type: 'gstin' },
  pan: { type: 'pan' },
  gst_registration_type: { type: 'enum', values: COMPANY_GST_TYPES, default: 'REGULAR' },
  state_code: { type: 'state_code', required: true },
  address: { type: 'text', max: 500 },
  city: { type: 'text', max: 120 },
  pincode: { type: 'pincode' },
  phone: { type: 'text', max: 15 },
  email: { type: 'email' },
  invoice_round_off: { type: 'bool', default: 1 },
  eway_bill_threshold: { type: 'decimal', min: 0, default: 50000 },
  credit_limit_action: { type: 'enum', values: ['BLOCK', 'WARN'], default: 'BLOCK' },
  invoice_terms: { type: 'text', max: 5000 },
};

function normalizeSettings(data) {
  if (data.gst_registration_type === 'UNREGISTERED' && data.gstin) {
    throw httpError(400, 'gstin must be empty when gst_registration_type is UNREGISTERED');
  }
  validateGstConsistency(data);
  if (!data.state_code) throw httpError(400, 'state_code is required');
  return data;
}

// ---------- financial years ----------

/** Financial year containing `date` for a company whose year starts in `startMonth`. */
function fyBounds(date, startMonth = 4) {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const end = addDays(`${startYear + 1}-${String(startMonth).padStart(2, '0')}-01`, -1);
  const code = startMonth === 1 ? String(startYear) : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  return { code, start, end };
}

async function getBooks(conn, companyId) {
  const [rows] = await conn.query('SELECT * FROM company_books WHERE company_id = ?', [companyId]);
  return rows[0] || null;
}

async function requireBooks(conn, companyId) {
  const books = await getBooks(conn, companyId);
  if (!books) {
    throw httpError(400, `Accounting is not set up for company ${companyId} — POST /api/accounting/companies/${companyId}/setup first`);
  }
  return books;
}

/** FY containing `date`; missing years from books start up to it are created automatically. */
async function ensureFinancialYear(conn, companyId, date, actor) {
  const books = await requireBooks(conn, companyId);
  const [rows] = await conn.query(
    'SELECT * FROM financial_years WHERE company_id = ? AND ? BETWEEN start_date AND end_date',
    [companyId, date]
  );
  if (rows.length) return rows[0];
  if (date < books.books_start_date) throw httpError(400, `Date ${date} is before the books start date ${books.books_start_date}`);
  let cursor = fyBounds(books.books_start_date, books.fy_start_month);
  let found = null;
  while (cursor.start <= date) {
    await conn.query(
      `INSERT IGNORE INTO financial_years (company_id, code, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?)`,
      [companyId, cursor.code, cursor.start, cursor.end, actor || 'system']
    );
    if (date >= cursor.start && date <= cursor.end) found = cursor;
    cursor = fyBounds(addDays(cursor.end, 1), books.fy_start_month);
  }
  const [[fy]] = await conn.query('SELECT * FROM financial_years WHERE company_id = ? AND code = ?', [companyId, found.code]);
  return fy;
}

/** FY for a posting date — must be OPEN. */
async function openFinancialYear(conn, companyId, date, actor) {
  const fy = await ensureFinancialYear(conn, companyId, date, actor);
  if (fy.status !== 'OPEN') throw httpError(400, `Financial year ${fy.code} is closed — no entries can be added or changed for ${date}`);
  return fy;
}

async function listFinancialYears(ctx, companyId) {
  ctx.assert('view');
  await assertCompanyUsable(ctx, companyId);
  const [rows] = await pool.query('SELECT * FROM financial_years WHERE company_id = ? ORDER BY start_date', [companyId]);
  return rows;
}

async function createNextFinancialYear(ctx, companyId, body = {}) {
  ctx.assert('manage');
  await assertCompanyUsable(ctx, companyId);
  return withTransaction(async (conn) => {
    const books = await requireBooks(conn, companyId);
    const [[last]] = await conn.query('SELECT * FROM financial_years WHERE company_id = ? ORDER BY start_date DESC LIMIT 1', [companyId]);
    const next = last ? fyBounds(addDays(last.end_date, 1), books.fy_start_month) : fyBounds(books.books_start_date, books.fy_start_month);
    await conn.query(
      'INSERT INTO financial_years (company_id, code, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?)',
      [companyId, next.code, next.start, next.end, ctx.actor]
    );
    await writeLog(conn, AUDIT, {
      companyId, entityType: 'FINANCIAL_YEAR', action: 'CREATED', effectiveDate: next.start, fyCode: next.code,
      reason: cleanText(body.reason), actor: ctx.actor, role: ctx.role, note: `${next.start} to ${next.end}`,
    });
    const [[fy]] = await conn.query('SELECT * FROM financial_years WHERE company_id = ? AND code = ?', [companyId, next.code]);
    return fy;
  });
}

async function setFinancialYearStatus(ctx, fyId, status, body = {}) {
  ctx.assert('close_year');
  const reason = cleanText(body.reason);
  if (!reason) throw httpError(400, 'reason is required');
  return withTransaction(async (conn) => {
    const [[fy]] = await conn.query('SELECT * FROM financial_years WHERE id = ? FOR UPDATE', [Number(fyId) || 0]);
    if (!fy || !ctx.canSeeCompany(fy.company_id)) throw httpError(404, 'Financial year not found');
    if (fy.status === status) throw httpError(400, `Financial year ${fy.code} is already ${status}`);
    if (status === 'CLOSED' && fy.end_date >= today()) throw httpError(400, `Financial year ${fy.code} has not ended yet`);
    await conn.query(
      'UPDATE financial_years SET status = ?, closed_by = ?, closed_at = NOW(), status_remarks = ? WHERE id = ?',
      [status, ctx.actor, reason, fy.id]
    );
    await writeLog(conn, AUDIT, {
      companyId: fy.company_id, entityType: 'FINANCIAL_YEAR', entityId: fy.id, action: status === 'CLOSED' ? 'CLOSED' : 'REOPENED',
      effectiveDate: fy.end_date, fyCode: fy.code, reason, actor: ctx.actor, role: ctx.role,
    }, [{ field: 'status', old: fy.status, new: status }]);
    const [[updated]] = await conn.query('SELECT * FROM financial_years WHERE id = ?', [fy.id]);
    return updated;
  });
}

// ---------- settings ----------

async function settingsAt(conn, companyId, date) {
  const versions = (await loadVersions(conn, SETTINGS_TABLE, 'company_id', [companyId])).get(companyId) || [];
  const { current } = resolveVersion(versions, date);
  if (!current) throw httpError(400, `Company accounting settings are not effective on ${date}`);
  return current;
}

function formatSettings(v) {
  if (!v) return null;
  return {
    version_id: v.id, ...outFields(SETTINGS_FIELDS, v),
    effective_from: v.effective_from, effective_to: v.effective_to, remarks: v.remarks, created_by: v.created_by,
  };
}

async function getSettings(ctx, companyId, query = {}) {
  ctx.assert('view');
  await assertCompanyUsable(ctx, companyId);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const books = await getBooks(pool, companyId);
  if (!books) return { company_id: Number(companyId), configured: false };
  const versions = (await loadVersions(pool, SETTINGS_TABLE, 'company_id', [Number(companyId)])).get(Number(companyId)) || [];
  const { current, upcoming } = resolveVersion(versions, asOf);
  return {
    company_id: Number(companyId),
    configured: true,
    books: {
      books_start_date: books.books_start_date, fy_start_month: books.fy_start_month, base_currency: books.base_currency,
    },
    as_of: asOf,
    settings: formatSettings(current || upcoming),
    upcoming_change: current && upcoming ? { version_id: upcoming.id, effective_from: upcoming.effective_from } : null,
    history: versions.map(formatSettings).reverse(),
  };
}

async function updateSettings(ctx, companyId, body = {}) {
  ctx.assert('manage');
  await assertCompanyUsable(ctx, companyId);
  const id = Number(companyId);
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const reason = cleanText(body.reason) ?? null;
  await withTransaction(async (conn) => {
    const books = await requireBooks(conn, id);
    if (effectiveDate < books.books_start_date) throw httpError(400, `effective_date cannot be before the books start date ${books.books_start_date}`);
    const versions = (await loadVersions(conn, SETTINGS_TABLE, 'company_id', [id])).get(id) || [];
    const latest = versions[versions.length - 1];
    const changes = readFields(SETTINGS_FIELDS, body, { partial: true });
    const changed = changedKeys(SETTINGS_FIELDS, changes, latest);
    if (!changed.length) throw httpError(400, 'No changes to save');
    const merged = normalizeSettings({ ...pick(SETTINGS_FIELDS, latest), ...changes });
    const { mode } = await saveVersion(conn, {
      table: SETTINGS_TABLE, fk: 'company_id', parentId: id, latest, fields: Object.keys(SETTINGS_FIELDS),
      data: dbRow(SETTINGS_FIELDS, merged), effectiveDate, remarks: reason, actor: ctx.actor,
    });
    await writeLog(conn, AUDIT, {
      companyId: id, entityType: 'SETTINGS', action: mode === 'CORRECTED' ? 'CORRECTED' : 'UPDATED',
      effectiveDate, reason, actor: ctx.actor, role: ctx.role,
    }, diff(latest, merged, changed));
  });
  return getSettings(ctx, id, { as_of: effectiveDate });
}

async function cancelSettingsVersion(ctx, companyId, versionId) {
  ctx.assert('manage');
  await assertCompanyUsable(ctx, companyId);
  const id = Number(companyId);
  await withTransaction(async (conn) => {
    const { cancelled } = await cancelLatestScheduled(conn, { table: SETTINGS_TABLE, fk: 'company_id', parentId: id, versionId });
    await writeLog(conn, AUDIT, {
      companyId: id, entityType: 'SETTINGS', action: 'SCHEDULE_CANCELLED', effectiveDate: cancelled.effective_from,
      actor: ctx.actor, role: ctx.role, note: `version ${cancelled.id}`,
    });
  });
  return getSettings(ctx, id);
}

/** One-time setup: books, first settings version, financial years, default ledgers, mapping and numbering. */
async function setupBooks(ctx, companyId, body = {}, { seedLedgers, seedSeries }) {
  ctx.assert('manage');
  await assertCompanyUsable(ctx, companyId);
  const id = Number(companyId);
  const fyStartMonth = body.fy_start_month === undefined ? 4 : Number(body.fy_start_month);
  if (!Number.isInteger(fyStartMonth) || fyStartMonth < 1 || fyStartMonth > 12) throw httpError(400, 'fy_start_month must be 1-12');
  const booksStart = parseDate(body.books_start_date, 'books_start_date') || fyBounds(today(), fyStartMonth).start;
  if (booksStart > today()) throw httpError(400, 'books_start_date cannot be in the future');
  const settings = normalizeSettings(readFields(SETTINGS_FIELDS, body));
  const reason = cleanText(body.reason) ?? 'Accounting setup';

  await withTransaction(async (conn) => {
    await conn.query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [id]);
    if (await getBooks(conn, id)) throw httpError(409, 'Accounting is already set up for this company');
    await conn.query(
      'INSERT INTO company_books (company_id, books_start_date, fy_start_month, created_by) VALUES (?, ?, ?, ?)',
      [id, booksStart, fyStartMonth, ctx.actor]
    );
    await insertFirstVersion(conn, {
      table: SETTINGS_TABLE, fk: 'company_id', parentId: id, fields: Object.keys(SETTINGS_FIELDS),
      data: dbRow(SETTINGS_FIELDS, settings), effectiveDate: booksStart, remarks: reason, actor: ctx.actor,
    });
    await ensureFinancialYear(conn, id, today() > booksStart ? today() : booksStart, ctx.actor);
    await seedLedgers(conn, id, booksStart, ctx.actor);
    await seedSeries(conn, id, booksStart, ctx.actor);
    await writeLog(conn, AUDIT, {
      companyId: id, entityType: 'BOOKS', action: 'SETUP', effectiveDate: booksStart, reason, actor: ctx.actor, role: ctx.role,
    }, [
      { field: 'books_start_date', old: null, new: booksStart },
      { field: 'fy_start_month', old: null, new: fyStartMonth },
      ...Object.keys(SETTINGS_FIELDS).filter((f) => settings[f] !== null && settings[f] !== undefined)
        .map((f) => ({ field: f, old: null, new: settings[f] })),
    ]);
  });
  return getSettings(ctx, id);
}

module.exports = {
  SETTINGS_FIELDS,
  COMPANY_GST_TYPES,
  fyBounds,
  getBooks,
  requireBooks,
  ensureFinancialYear,
  openFinancialYear,
  listFinancialYears,
  createNextFinancialYear,
  setFinancialYearStatus,
  settingsAt,
  getSettings,
  updateSettings,
  cancelSettingsVersion,
  setupBooks,
};
