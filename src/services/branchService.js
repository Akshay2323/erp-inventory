const pool = require('../config/db');
const { getHrmsStatus, listHrmsBranches, getHrmsBranchForForm } = require('./hrmsService');
const { normalizeState } = require('./locationService');
const {
  companyAccess, companyAccessFilter, loadAccessibleCompany, loadCompanyVersions,
} = require('./companyService');
const {
  EMAIL_RE, httpError, today, parseDate, cleanText, actorLabel,
} = require('./common');
const {
  loadVersions, resolveVersion, changedFields,
  insertFirstVersion, updateLatestVersion, cancelScheduledVersion: cancelVersion,
} = require('./versioning');

const TEXT_FIELDS = [
  'name', 'address', 'city', 'state', 'pincode', 'phone', 'email', 'contact_person_name', 'location_label',
];
const VERSION_FIELDS = [...TEXT_FIELDS, 'status', 'latitude', 'longitude'];
const VERSION_TABLE = { table: 'branch_versions', fk: 'branch_id' };
const STATUSES = ['ACTIVE', 'INACTIVE'];
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-/.]{0,49}$/;
const PINCODE_RE = /^[1-9][0-9]{5}$/;
const PHONE_RE = /^\+?[0-9][0-9 -]{5,18}[0-9]$/;

// ---------- normalize / validate ----------

/** DECIMAL(10,7) comes back as '21.1652000' — keep the same shape so change detection works. */
function normalizeCoord(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError(400, `${field} must be a number`);
  return n.toFixed(7);
}

function normalizeCode(value) {
  const code = cleanText(value);
  if (!code) return code;
  if (!CODE_RE.test(code)) {
    throw httpError(400, 'code may contain letters, numbers, space, - _ / . (max 50)');
  }
  return code.toUpperCase();
}

function readVersionInput(body) {
  const data = {};
  for (const f of TEXT_FIELDS) if (body[f] !== undefined) data[f] = cleanText(body[f]);
  if (body.status !== undefined) data.status = cleanText(body.status)?.toUpperCase() ?? null;
  if (body.latitude !== undefined) data.latitude = normalizeCoord(body.latitude, 'latitude');
  if (body.longitude !== undefined) data.longitude = normalizeCoord(body.longitude, 'longitude');
  if (data.state) {
    const state = normalizeState(data.state);
    if (!state) throw httpError(400, `state "${data.state}" is not a valid Indian state / UT`);
    data.state = state;
  }
  if (data.email) data.email = data.email.toLowerCase();
  return data;
}

function validateVersion(data) {
  if (!data.name) throw httpError(400, 'name is required');
  if (!data.city) throw httpError(400, 'city is required');
  if (!data.state) throw httpError(400, 'state is required');
  if (!STATUSES.includes(data.status)) throw httpError(400, `status must be one of ${STATUSES.join(', ')}`);
  if (data.pincode && !PINCODE_RE.test(data.pincode)) throw httpError(400, 'pincode must be a 6-digit Indian pincode');
  if (data.phone && !PHONE_RE.test(data.phone)) throw httpError(400, 'phone is not valid');
  if (data.email && !EMAIL_RE.test(data.email)) throw httpError(400, 'email is not valid');

  const hasLat = data.latitude != null;
  const hasLng = data.longitude != null;
  if (hasLat !== hasLng) throw httpError(400, 'latitude and longitude must be given together');
  if (!hasLat) data.location_label = null;
}

async function assertBranchNameFree(conn, companyId, name, excludeBranchId = null) {
  const [rows] = await conn.query(
    `SELECT bv.branch_id FROM branch_versions bv
     JOIN branches b ON b.id = bv.branch_id
     WHERE b.company_id = ? AND bv.effective_to IS NULL
       AND LOWER(bv.name) = LOWER(?) AND bv.branch_id <> ?`,
    [companyId, name, excludeBranchId || 0]
  );
  if (rows.length) throw httpError(409, `Branch "${name}" already exists in this company`);
}

async function assertCodeFree(conn, companyId, code, excludeBranchId = null) {
  const [rows] = await conn.query(
    'SELECT id FROM branches WHERE company_id = ? AND code = ? AND id <> ?',
    [companyId, code, excludeBranchId || 0]
  );
  if (rows.length) throw httpError(409, `Branch code "${code}" already exists in this company`);
}

// ---------- read ----------

function formatVersion(v) {
  return {
    version_id: v.id,
    name: v.name,
    address: v.address,
    city: v.city,
    state: v.state,
    pincode: v.pincode,
    phone: v.phone,
    email: v.email,
    contact_person_name: v.contact_person_name,
    status: v.status,
    location: v.latitude != null
      ? { latitude: Number(v.latitude), longitude: Number(v.longitude), label: v.location_label }
      : null,
    effective_from: v.effective_from,
    effective_to: v.effective_to,
    remarks: v.remarks,
    created_by: v.created_by,
    created_at: v.created_at,
  };
}

function resolveBranchAsOf(versions, queryAsOf) {
  const explicit = parseDate(queryAsOf, 'as_of');
  if (explicit) return { asOf: explicit, mode: 'AS_OF' };
  if (!versions.length) return { asOf: today(), mode: 'LATEST' };
  return { asOf: String(versions[versions.length - 1].effective_from).slice(0, 10), mode: 'LATEST' };
}

function shapeBranch(branch, versions, companyName, asOf, mode = 'AS_OF') {
  const { current, upcoming } = resolveVersion(versions, asOf);
  const shown = mode === 'LATEST' && versions.length
    ? versions[versions.length - 1]
    : (current || upcoming);
  return {
    id: branch.id,
    company_id: branch.company_id,
    company_name: companyName,
    code: branch.code,
    source: branch.source,
    hrms_branch_id: branch.hrms_branch_id ? Number(branch.hrms_branch_id) : null,
    as_of: asOf,
    view: mode === 'LATEST' ? 'latest' : 'as_of',
    effective_status: mode === 'LATEST' ? 'LATEST' : (current ? 'EFFECTIVE' : 'NOT_YET_EFFECTIVE'),
    ...(shown ? formatVersion(shown) : {}),
    upcoming_change: mode === 'AS_OF' && current && upcoming
      ? { version_id: upcoming.id, effective_from: upcoming.effective_from, remarks: upcoming.remarks }
      : null,
    created_by: branch.created_by,
    created_at: branch.created_at,
    updated_at: branch.updated_at,
  };
}

async function companyNamesAsOf(companyIds, asOf) {
  const versions = await loadVersions(pool, 'company_versions', 'company_id', [...new Set(companyIds)]);
  const names = new Map();
  for (const [id, list] of versions) {
    const { current, upcoming } = resolveVersion(list, asOf);
    names.set(id, (current || upcoming)?.company_name || null);
  }
  return names;
}

async function loadBranchVersions(conn, branchId) {
  return (await loadVersions(conn, VERSION_TABLE.table, VERSION_TABLE.fk, [branchId])).get(branchId) || [];
}

async function listBranches(user, authSource, query = {}) {
  const filter = companyAccessFilter(companyAccess(user, authSource));
  if (!filter) return [];

  let sql = `SELECT b.* FROM branches b JOIN companies c ON c.id = b.company_id WHERE ${filter.sql}`;
  const params = [...filter.params];
  if (cleanText(query.company_id)) {
    sql += ' AND b.company_id = ?';
    params.push(Number(query.company_id));
  }

  const [branches] = await pool.query(sql, params);
  const versions = await loadVersions(pool, VERSION_TABLE.table, VERSION_TABLE.fk, branches.map((b) => b.id));
  const nameAsOf = parseDate(query.as_of, 'as_of') || today();
  const names = await companyNamesAsOf(branches.map((b) => b.company_id), nameAsOf);
  let result = branches.map((b) => {
    const list = versions.get(b.id) || [];
    const { asOf, mode } = resolveBranchAsOf(list, query.as_of);
    return shapeBranch(b, list, names.get(b.company_id), asOf, mode);
  });

  const status = cleanText(query.status)?.toUpperCase();
  if (status) result = result.filter((b) => b.status === status);
  const search = cleanText(query.search)?.toLowerCase();
  if (search) {
    result = result.filter((b) =>
      [b.name, b.code, b.city, b.contact_person_name].some((v) => v && v.toLowerCase().includes(search))
    );
  }
  return result.sort((a, b) =>
    String(a.company_name).localeCompare(String(b.company_name)) || String(a.name).localeCompare(String(b.name))
  );
}

async function loadAccessibleBranch(id, access) {
  const [rows] = await pool.query('SELECT * FROM branches WHERE id = ?', [id]);
  if (!rows.length) throw httpError(404, 'Branch not found');
  try {
    await loadAccessibleCompany(pool, rows[0].company_id, access);
  } catch {
    throw httpError(404, 'Branch not found');
  }
  return rows[0];
}

async function getBranch(id, user, authSource, query = {}) {
  const branch = await loadAccessibleBranch(id, companyAccess(user, authSource));
  const versions = await loadBranchVersions(pool, branch.id);
  const { asOf, mode } = resolveBranchAsOf(versions, query.as_of);
  const names = await companyNamesAsOf([branch.company_id], asOf);
  return {
    ...shapeBranch(branch, versions, names.get(branch.company_id), asOf, mode),
    versions: versions.map(formatVersion).reverse(),
  };
}

// ---------- HRMS ----------

async function loadCompanyForHrms(companyId, user, authSource) {
  if (!cleanText(companyId)) throw httpError(400, 'company_id is required');
  const company = await loadAccessibleCompany(pool, Number(companyId), companyAccess(user, authSource));
  if (!company.hrms_tenant_id) {
    throw httpError(400, 'This company was not added from HRMS — enter branch details manually');
  }
  return company;
}

async function getBranchHrmsStatus(companyId, user, authSource) {
  const status = await getHrmsStatus(user, authSource);
  if (!status.available || !cleanText(companyId)) return status;
  try {
    await loadCompanyForHrms(companyId, user, authSource);
    return status;
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

async function listHrmsBranchesForCompany(companyId, user, authSource) {
  const company = await loadCompanyForHrms(companyId, user, authSource);
  const rows = await listHrmsBranches(company.hrms_tenant_id, user, authSource);
  const [linked] = await pool.query(
    'SELECT id, hrms_branch_id FROM branches WHERE hrms_branch_id IN (?)',
    [rows.length ? rows.map((r) => r.id) : [0]]
  );
  const linkedMap = new Map(linked.map((l) => [Number(l.hrms_branch_id), l.id]));
  return rows.map((r) => ({
    ...r,
    already_added: linkedMap.has(Number(r.id)),
    branch_id: linkedMap.get(Number(r.id)) || null,
  }));
}

async function getHrmsBranchPrefill(hrmsBranchId, companyId, user, authSource) {
  const company = await loadCompanyForHrms(companyId, user, authSource);
  const data = await getHrmsBranchForForm(hrmsBranchId, company.hrms_tenant_id, user, authSource);
  return { company_id: company.id, ...data, state: normalizeState(data.state) || data.state };
}

// ---------- create ----------

async function createBranch(body, user, authSource) {
  const access = companyAccess(user, authSource);
  if (!cleanText(body.company_id)) throw httpError(400, 'company_id is required');
  const company = await loadAccessibleCompany(pool, Number(body.company_id), access);
  if (!company.is_active) throw httpError(400, 'Company is inactive');

  const effectiveFrom = parseDate(body.effective_date, 'effective_date') || today();
  const companyVersions = await loadCompanyVersions(pool, company.id);
  const companyStart = companyVersions[0]?.effective_from;
  if (companyStart && effectiveFrom < companyStart) {
    throw httpError(400, `effective_date cannot be before the company's effective date (${companyStart})`);
  }

  const data = readVersionInput(body);
  let code = normalizeCode(body.code);

  let hrmsBranchId = null;
  if (cleanText(body.hrms_branch_id)) {
    hrmsBranchId = Number(body.hrms_branch_id);
    if (!hrmsBranchId) throw httpError(400, 'hrms_branch_id must be a number');
    const hrms = await getHrmsBranchPrefill(hrmsBranchId, company.id, user, authSource);
    const hrmsData = readVersionInput({ ...hrms, state: normalizeState(hrms.state) || undefined });
    for (const f of VERSION_FIELDS) data[f] = data[f] ?? hrmsData[f] ?? null;
    code = code || normalizeCode(hrms.code);
  }
  for (const f of VERSION_FIELDS) data[f] = data[f] ?? null;
  data.status = data.status || 'ACTIVE';
  if (!code) throw httpError(400, 'code is required');
  validateVersion(data);

  const actor = actorLabel(user);
  const conn = await pool.getConnection();
  let branchId;
  try {
    await conn.beginTransaction();
    if (hrmsBranchId) {
      const [linked] = await conn.query('SELECT id FROM branches WHERE hrms_branch_id = ?', [hrmsBranchId]);
      if (linked.length) throw httpError(409, `This HRMS branch is already added (branch id ${linked[0].id})`);
    }
    await assertCodeFree(conn, company.id, code);
    await assertBranchNameFree(conn, company.id, data.name);

    const [result] = await conn.query(
      `INSERT INTO branches (company_id, code, source, hrms_branch_id, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [company.id, code, hrmsBranchId ? 'HRMS' : 'MANUAL', hrmsBranchId, actor]
    );
    branchId = result.insertId;
    await insertFirstVersion(conn, {
      ...VERSION_TABLE,
      parentId: branchId,
      fields: VERSION_FIELDS,
      data,
      effectiveDate: effectiveFrom,
      remarks: cleanText(body.remarks),
      actor,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getBranch(branchId, user, authSource, { as_of: effectiveFrom });
}

// ---------- update ----------

/** Edit with effective date — see services/versioning.js. `code` changes apply immediately (not versioned). */
async function updateBranch(id, body, user, authSource) {
  const branch = await loadAccessibleBranch(id, companyAccess(user, authSource));
  if (cleanText(body.company_id) && Number(body.company_id) !== Number(branch.company_id)) {
    throw httpError(400, 'A branch cannot be moved to another company');
  }
  const versions = await loadBranchVersions(pool, branch.id);
  const latest = versions[versions.length - 1];
  if (!latest) throw httpError(500, 'Branch has no version history');

  const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
  const remarks = body.remarks !== undefined ? cleanText(body.remarks) : undefined;
  const changes = readVersionInput(body);
  const base = latest;
  const baseFrom = String(base.effective_from).slice(0, 10);
  const fieldChanged = changedFields(changes, base);
  const dateChanged = effectiveDate !== baseFrom;
  const remarksChanged = remarks !== undefined && remarks !== (base.remarks ?? null);

  const code = body.code !== undefined ? normalizeCode(body.code) : undefined;
  if (code === null) throw httpError(400, 'code cannot be empty');
  const codeChanged = code !== undefined && code !== branch.code;

  let merged = null;
  if (fieldChanged.length || dateChanged || remarksChanged) {
    merged = { ...Object.fromEntries(VERSION_FIELDS.map((f) => [f, base[f]])), ...changes };
    validateVersion(merged);
  }
  if (!merged && !codeChanged) throw httpError(400, 'No changes to save');

  const actor = actorLabel(user);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (codeChanged) {
      await assertCodeFree(conn, branch.company_id, code, branch.id);
      await conn.query('UPDATE branches SET code = ? WHERE id = ?', [code, branch.id]);
    }
    if (merged) {
      if (changes.name !== undefined) await assertBranchNameFree(conn, branch.company_id, merged.name, branch.id);
      await updateLatestVersion(conn, {
        ...VERSION_TABLE,
        parentId: branch.id,
        fields: VERSION_FIELDS,
        data: merged,
        effectiveDate,
        remarks: remarks !== undefined ? remarks : base.remarks,
        actor,
      });
    }
    await conn.query('UPDATE branches SET updated_at = NOW() WHERE id = ?', [branch.id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getBranch(branch.id, user, authSource);
}

async function cancelScheduledVersion(branchId, versionId, user, authSource) {
  const branch = await loadAccessibleBranch(branchId, companyAccess(user, authSource));
  await cancelVersion({ ...VERSION_TABLE, parentId: branch.id, versionId });
  return getBranch(branch.id, user, authSource);
}

module.exports = {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  cancelScheduledVersion,
  getBranchHrmsStatus,
  listHrmsBranchesForCompany,
  getHrmsBranchPrefill,
};
