/**
 * Chart of accounts (effective-dated ledgers) and ledger mapping (effective-dated key → ledger).
 */
const pool = require('../../config/db');
const { httpError, today, parseDate, cleanText } = require('../common');
const {
  loadVersions, resolveVersion, insertFirstVersion, saveVersion, cancelLatestScheduled,
} = require('../versioning');
const { readFields, assertRequired, changedKeys, pick, dbRow, outFields } = require('../party/fields');
const { assertCompanyUsable } = require('../party/access');
const { LEDGER_GROUPS, MAPPING_KEYS } = require('../../config/accountingConfig');
const { requireBooks } = require('./books');
const {
  writeLog, diff, withTransaction, requireCompanyId, r2,
} = require('./common');

const AUDIT = 'accounting_audit_logs';
const CODE_RE = /^[A-Z0-9][A-Z0-9\-_/]{0,29}$/;
const CONTROL_GROUPS = ['SUNDRY_DEBTORS', 'SUNDRY_CREDITORS'];

const LEDGER_FIELDS = {
  name: { type: 'text', max: 150, required: true },
  ledger_group: { type: 'enum', values: Object.keys(LEDGER_GROUPS), required: true },
  status: { type: 'enum', values: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  description: { type: 'text', max: 500 },
  bank_account_no: { type: 'account_number' },
  ifsc: { type: 'ifsc' },
};

function formatLedgerVersion(v) {
  if (!v) return null;
  return {
    version_id: v.id, ...outFields(LEDGER_FIELDS, v), nature: LEDGER_GROUPS[v.ledger_group],
    effective_from: v.effective_from, effective_to: v.effective_to, remarks: v.remarks, created_by: v.created_by,
  };
}

async function loadLedger(conn, ctx, id) {
  const [rows] = await conn.query('SELECT * FROM ledgers WHERE id = ?', [Number(id) || 0]);
  if (!rows.length || !ctx.canSeeCompany(rows[0].company_id)) throw httpError(404, 'Ledger not found');
  return rows[0];
}

/** Active ledger version on `date`, optionally restricted to groups. */
async function resolveLedger(conn, companyId, ledgerId, date, { groups = null, label = 'ledger' } = {}) {
  const [rows] = await conn.query('SELECT * FROM ledgers WHERE id = ? AND company_id = ?', [Number(ledgerId) || 0, companyId]);
  if (!rows.length) throw httpError(400, `${label} ${ledgerId} not found in this company`);
  const versions = (await loadVersions(conn, 'ledger_versions', 'ledger_id', [rows[0].id])).get(rows[0].id) || [];
  const { current } = resolveVersion(versions, date);
  if (!current || current.status !== 'ACTIVE') throw httpError(400, `${label} ${rows[0].code} is not active on ${date}`);
  if (groups && !groups.includes(current.ledger_group)) {
    throw httpError(400, `${label} ${rows[0].code} (${current.ledger_group}) must be in group ${groups.join(' / ')}`);
  }
  return { id: rows[0].id, code: rows[0].code, name: current.name, group: current.ledger_group };
}

/** Ledger mapped to `key` on `date`. */
async function resolveMapping(conn, companyId, key, date) {
  const [[mapping]] = await conn.query('SELECT id FROM ledger_mappings WHERE company_id = ? AND mapping_key = ?', [companyId, key]);
  if (!mapping) throw httpError(400, `Ledger mapping ${key} is missing`);
  const versions = (await loadVersions(conn, 'ledger_mapping_versions', 'mapping_id', [mapping.id])).get(mapping.id) || [];
  const { current } = resolveVersion(versions, date);
  if (!current) throw httpError(400, `Ledger mapping ${key} is not effective on ${date}`);
  return resolveLedger(conn, companyId, current.ledger_id, date, { groups: MAPPING_KEYS[key].groups, label: `Mapped ledger for ${key}` });
}

/** Mapping keys currently (latest version) pointing at a ledger. */
async function keysMappedTo(conn, ledgerId) {
  const [rows] = await conn.query(
    `SELECT m.mapping_key FROM ledger_mappings m
     JOIN ledger_mapping_versions v ON v.mapping_id = m.id AND v.effective_to IS NULL
     WHERE v.ledger_id = ?`,
    [ledgerId]
  );
  return rows.map((r) => r.mapping_key);
}

async function seedLedgers(conn, companyId, effectiveDate, actor) {
  for (const [key, spec] of Object.entries(MAPPING_KEYS)) {
    const [name, group] = spec.ledger;
    const [ins] = await conn.query(
      'INSERT INTO ledgers (company_id, code, system_key, created_by) VALUES (?, ?, ?, ?)',
      [companyId, key, key, actor]
    );
    await insertFirstVersion(conn, {
      table: 'ledger_versions', fk: 'ledger_id', parentId: ins.insertId, fields: ['name', 'ledger_group', 'status'],
      data: { name, ledger_group: group, status: 'ACTIVE' }, effectiveDate, remarks: 'Default ledger', actor,
    });
    const [map] = await conn.query('INSERT INTO ledger_mappings (company_id, mapping_key) VALUES (?, ?)', [companyId, key]);
    await insertFirstVersion(conn, {
      table: 'ledger_mapping_versions', fk: 'mapping_id', parentId: map.insertId, fields: ['ledger_id'],
      data: { ledger_id: ins.insertId }, effectiveDate, remarks: 'Default mapping', actor,
    });
  }
}

// ---------- ledgers ----------

async function listLedgers(ctx, query = {}) {
  ctx.assert('view');
  const companyId = requireCompanyId(query.company_id);
  await assertCompanyUsable(ctx, companyId);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const [ledgers] = await pool.query('SELECT * FROM ledgers WHERE company_id = ? ORDER BY code', [companyId]);
  const versions = await loadVersions(pool, 'ledger_versions', 'ledger_id', ledgers.map((l) => l.id));
  const group = cleanText(query.group)?.toUpperCase();
  const status = cleanText(query.status)?.toUpperCase();
  const search = cleanText(query.search)?.toLowerCase();
  return ledgers.map((l) => {
    const { current, upcoming } = resolveVersion(versions.get(l.id) || [], asOf);
    const v = current || upcoming;
    return {
      id: l.id, code: l.code, system_key: l.system_key, ...formatLedgerVersion(v),
      effective_status: current ? 'EFFECTIVE' : 'NOT_YET_EFFECTIVE',
      opening_balance: Number(l.opening_balance), opening_type: l.opening_type,
    };
  }).filter((l) => (!group || l.ledger_group === group) && (!status || l.status === status)
    && (!search || l.name.toLowerCase().includes(search) || l.code.toLowerCase().includes(search)));
}

async function getLedger(ctx, id, query = {}) {
  ctx.assert('view');
  const ledger = await loadLedger(pool, ctx, id);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const versions = (await loadVersions(pool, 'ledger_versions', 'ledger_id', [ledger.id])).get(ledger.id) || [];
  const { current, upcoming } = resolveVersion(versions, asOf);
  return {
    id: ledger.id, company_id: ledger.company_id, code: ledger.code, system_key: ledger.system_key,
    opening_balance: Number(ledger.opening_balance), opening_type: ledger.opening_type,
    as_of: asOf, ...formatLedgerVersion(current || upcoming),
    upcoming_change: current && upcoming ? { version_id: upcoming.id, effective_from: upcoming.effective_from } : null,
    mapped_to: await keysMappedTo(pool, ledger.id),
    history: versions.map(formatLedgerVersion).reverse(),
  };
}

function readOpening(body, group) {
  const out = {};
  if (body.opening_balance !== undefined) {
    const n = Number(body.opening_balance);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, 'opening_balance must be a number >= 0');
    out.opening_balance = r2(n).toFixed(2);
  }
  if (body.opening_type !== undefined) {
    const t = String(body.opening_type).toUpperCase();
    if (!['DR', 'CR'].includes(t)) throw httpError(400, 'opening_type must be DR or CR');
    out.opening_type = t;
  }
  if (CONTROL_GROUPS.includes(group) && Number(out.opening_balance) > 0) {
    throw httpError(400, 'Client / vendor opening balances are entered as opening bills per client / vendor, not on the control ledger');
  }
  return out;
}

async function createLedger(ctx, body = {}) {
  ctx.assert('manage');
  const companyId = requireCompanyId(body.company_id);
  await assertCompanyUsable(ctx, companyId);
  const data = readFields(LEDGER_FIELDS, body);
  assertRequired(LEDGER_FIELDS, data);
  const opening = readOpening(body, data.ledger_group);
  const reason = cleanText(body.reason) ?? null;
  const id = await withTransaction(async (conn) => {
    const books = await requireBooks(conn, companyId);
    const effectiveDate = parseDate(body.effective_date, 'effective_date') || books.books_start_date;
    if (effectiveDate < books.books_start_date) throw httpError(400, `effective_date cannot be before the books start date ${books.books_start_date}`);
    let code = cleanText(body.code)?.toUpperCase();
    if (code && !CODE_RE.test(code)) throw httpError(400, 'code may contain letters, numbers, - _ / (max 30)');
    if (!code) {
      const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM ledgers WHERE company_id = ? AND system_key IS NULL", [companyId]);
      code = `L${String(Number(n) + 1).padStart(4, '0')}`;
    }
    const [dup] = await conn.query('SELECT id FROM ledgers WHERE company_id = ? AND code = ?', [companyId, code]);
    if (dup.length) throw httpError(409, `Ledger code ${code} already exists`);
    const [ins] = await conn.query(
      'INSERT INTO ledgers (company_id, code, opening_balance, opening_type, created_by) VALUES (?, ?, ?, ?, ?)',
      [companyId, code, opening.opening_balance || 0, opening.opening_type || 'DR', ctx.actor]
    );
    await insertFirstVersion(conn, {
      table: 'ledger_versions', fk: 'ledger_id', parentId: ins.insertId, fields: Object.keys(LEDGER_FIELDS),
      data: dbRow(LEDGER_FIELDS, data), effectiveDate, remarks: reason, actor: ctx.actor,
    });
    await writeLog(conn, AUDIT, {
      companyId, entityType: 'LEDGER', entityId: ins.insertId, action: 'CREATED', effectiveDate, reason, actor: ctx.actor, role: ctx.role,
    }, [{ field: 'code', old: null, new: code }, ...diff({}, { ...data, ...opening }, [...Object.keys(LEDGER_FIELDS), 'opening_balance', 'opening_type'])]);
    return ins.insertId;
  });
  return getLedger(ctx, id);
}

async function updateLedger(ctx, id, body = {}) {
  ctx.assert('manage');
  if (body.code !== undefined || body.company_id !== undefined) throw httpError(400, 'code and company_id cannot be changed');
  const ledger = await loadLedger(pool, ctx, id);
  const reason = cleanText(body.reason) ?? null;
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  await withTransaction(async (conn) => {
    const versions = (await loadVersions(conn, 'ledger_versions', 'ledger_id', [ledger.id])).get(ledger.id) || [];
    const latest = versions[versions.length - 1];
    const changes = readFields(LEDGER_FIELDS, body, { partial: true });
    const changed = changedKeys(LEDGER_FIELDS, changes, latest);
    const merged = { ...pick(LEDGER_FIELDS, latest), ...changes };
    const opening = readOpening(body, merged.ledger_group);
    const openingChanged = diff(ledger, opening, Object.keys(opening));
    if (!changed.length && !openingChanged.length) throw httpError(400, 'No changes to save');

    if (changed.length) {
      const mapped = await keysMappedTo(conn, ledger.id);
      for (const key of mapped) {
        if (merged.status !== 'ACTIVE') throw httpError(400, `Ledger is mapped to ${key} — change the mapping before deactivating it`);
        if (!MAPPING_KEYS[key].groups.includes(merged.ledger_group)) {
          throw httpError(400, `Ledger is mapped to ${key}, which needs group ${MAPPING_KEYS[key].groups.join(' / ')}`);
        }
      }
      if (changed.includes('ledger_group') && CONTROL_GROUPS.includes(merged.ledger_group) && Number(ledger.opening_balance) > 0) {
        throw httpError(400, 'Control ledgers (Sundry Debtors / Creditors) cannot carry an opening balance');
      }
      const { mode } = await saveVersion(conn, {
        table: 'ledger_versions', fk: 'ledger_id', parentId: ledger.id, latest, fields: Object.keys(LEDGER_FIELDS),
        data: dbRow(LEDGER_FIELDS, merged), effectiveDate, remarks: reason, actor: ctx.actor,
      });
      await writeLog(conn, AUDIT, {
        companyId: ledger.company_id, entityType: 'LEDGER', entityId: ledger.id, action: mode === 'CORRECTED' ? 'CORRECTED' : 'UPDATED',
        effectiveDate, reason, actor: ctx.actor, role: ctx.role,
      }, diff(latest, merged, changed));
    }
    if (openingChanged.length) {
      await conn.query('UPDATE ledgers SET opening_balance = COALESCE(?, opening_balance), opening_type = COALESCE(?, opening_type) WHERE id = ?',
        [opening.opening_balance ?? null, opening.opening_type ?? null, ledger.id]);
      const books = await requireBooks(conn, ledger.company_id);
      await writeLog(conn, AUDIT, {
        companyId: ledger.company_id, entityType: 'LEDGER', entityId: ledger.id, action: 'OPENING_CHANGED',
        effectiveDate: books.books_start_date, reason, actor: ctx.actor, role: ctx.role,
      }, openingChanged);
    }
  });
  return getLedger(ctx, ledger.id, { as_of: effectiveDate });
}

async function cancelLedgerVersion(ctx, id, versionId) {
  ctx.assert('manage');
  const ledger = await loadLedger(pool, ctx, id);
  await withTransaction(async (conn) => {
    const { cancelled } = await cancelLatestScheduled(conn, { table: 'ledger_versions', fk: 'ledger_id', parentId: ledger.id, versionId });
    await writeLog(conn, AUDIT, {
      companyId: ledger.company_id, entityType: 'LEDGER', entityId: ledger.id, action: 'SCHEDULE_CANCELLED',
      effectiveDate: cancelled.effective_from, actor: ctx.actor, role: ctx.role, note: `version ${cancelled.id}`,
    });
  });
  return getLedger(ctx, ledger.id);
}

// ---------- mapping ----------

async function getMappings(ctx, companyId, query = {}) {
  ctx.assert('view');
  await assertCompanyUsable(ctx, companyId);
  const asOf = parseDate(query.as_of, 'as_of') || today();
  const [maps] = await pool.query('SELECT * FROM ledger_mappings WHERE company_id = ? ORDER BY mapping_key', [Number(companyId)]);
  const versions = await loadVersions(pool, 'ledger_mapping_versions', 'mapping_id', maps.map((m) => m.id));
  const ledgerIds = [...new Set([...versions.values()].flat().map((v) => v.ledger_id))];
  const [ledgers] = ledgerIds.length ? await pool.query('SELECT id, code FROM ledgers WHERE id IN (?)', [ledgerIds]) : [[]];
  const codes = new Map(ledgers.map((l) => [l.id, l.code]));
  return maps.map((m) => {
    const list = versions.get(m.id) || [];
    const { current, upcoming } = resolveVersion(list, asOf);
    const v = current || upcoming;
    return {
      mapping_key: m.mapping_key,
      allowed_groups: MAPPING_KEYS[m.mapping_key]?.groups,
      ledger_id: v?.ledger_id ?? null,
      ledger_code: codes.get(v?.ledger_id) ?? null,
      effective_from: v?.effective_from ?? null,
      upcoming_change: current && upcoming
        ? { version_id: upcoming.id, ledger_id: upcoming.ledger_id, ledger_code: codes.get(upcoming.ledger_id), effective_from: upcoming.effective_from }
        : null,
      history: list.map((x) => ({
        version_id: x.id, ledger_id: x.ledger_id, ledger_code: codes.get(x.ledger_id),
        effective_from: x.effective_from, effective_to: x.effective_to, remarks: x.remarks, created_by: x.created_by,
      })).reverse(),
    };
  });
}

async function updateMappings(ctx, companyId, body = {}) {
  ctx.assert('manage');
  await assertCompanyUsable(ctx, companyId);
  const id = Number(companyId);
  const mappings = body.mappings;
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings) || !Object.keys(mappings).length) {
    throw httpError(400, 'mappings must be an object like { "SALES": 12 }');
  }
  const effectiveDate = parseDate(body.effective_date, 'effective_date') || today();
  const reason = cleanText(body.reason) ?? null;
  await withTransaction(async (conn) => {
    const books = await requireBooks(conn, id);
    if (effectiveDate < books.books_start_date) throw httpError(400, `effective_date cannot be before the books start date ${books.books_start_date}`);
    let changes = 0;
    for (const [rawKey, ledgerId] of Object.entries(mappings)) {
      const key = rawKey.toUpperCase();
      if (!MAPPING_KEYS[key]) throw httpError(400, `Unknown mapping key ${rawKey}`);
      const ledger = await resolveLedger(conn, id, ledgerId, effectiveDate, { groups: MAPPING_KEYS[key].groups, label: `Ledger for ${key}` });
      const [[mapping]] = await conn.query('SELECT id FROM ledger_mappings WHERE company_id = ? AND mapping_key = ?', [id, key]);
      const versions = (await loadVersions(conn, 'ledger_mapping_versions', 'mapping_id', [mapping.id])).get(mapping.id) || [];
      const latest = versions[versions.length - 1];
      if (latest.ledger_id === ledger.id) continue;
      if (['CLIENT_CONTROL', 'VENDOR_CONTROL'].includes(key)) {
        throw httpError(400, `${key} cannot be remapped — rename the existing control ledger instead`);
      }
      const { mode } = await saveVersion(conn, {
        table: 'ledger_mapping_versions', fk: 'mapping_id', parentId: mapping.id, latest, fields: ['ledger_id'],
        data: { ledger_id: ledger.id }, effectiveDate, remarks: reason, actor: ctx.actor,
      });
      await writeLog(conn, AUDIT, {
        companyId: id, entityType: 'MAPPING', entityId: mapping.id, action: mode === 'CORRECTED' ? 'CORRECTED' : 'UPDATED',
        effectiveDate, reason, actor: ctx.actor, role: ctx.role,
      }, [{ field: key, old: latest.ledger_id, new: ledger.id }]);
      changes += 1;
    }
    if (!changes) throw httpError(400, 'No changes to save');
  });
  return getMappings(ctx, id, { as_of: effectiveDate });
}

module.exports = {
  LEDGER_FIELDS,
  seedLedgers,
  resolveLedger,
  resolveMapping,
  listLedgers,
  getLedger,
  createLedger,
  updateLedger,
  cancelLedgerVersion,
  getMappings,
  updateMappings,
};
