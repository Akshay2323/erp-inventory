const path = require('path');
const pool = require('../config/db');
const { encryptPassword } = require('./passwordService');
const { ROLES } = require('../config/roles');
const { getHrmsTenantForForm, hrmsTenantScope } = require('./hrmsService');
const {
  EMAIL_RE, httpError, today, parseDate, cleanText, isTruthy, parseBool, actorLabel, removeUploadedFile,
} = require('./common');
const {
  loadVersions, resolveVersion, changedFields,
  insertFirstVersion, updateLatestVersion, cancelScheduledVersion: cancelVersion,
} = require('./versioning');

const TEXT_FIELDS = ['company_name', 'legal_name', 'email', 'address'];
const SUBSCRIPTION_FIELDS = ['subscription_start', 'subscription_end'];
const VERSION_FIELDS = [...TEXT_FIELDS, 'logo', ...SUBSCRIPTION_FIELDS];
const VERSION_TABLE = { table: 'company_versions', fk: 'company_id' };
const MIN_PASSWORD = 6;
const LOGO_PUBLIC_DIR = '/uploads/company-logos';
const LOGO_DISK_DIR = path.join(__dirname, '..', '..', 'uploads', 'company-logos');

function logoPathFor(file) {
  return file ? `${LOGO_PUBLIC_DIR}/${file.filename}` : null;
}

function subscriptionStatus(version, asOf) {
  if (!version) return null;
  if (version.subscription_start && asOf < version.subscription_start) return 'NOT_STARTED';
  if (version.subscription_end && asOf > version.subscription_end) return 'EXPIRED';
  return 'ACTIVE';
}

// ---------- access ----------

/**
 * all            → every company
 * localCompanyId → local COMPANY_ADMIN's own company
 * hrmsTenantIds  → portal Group/Company Admin: companies linked to these HRMS tenants
 * isManager      → may create companies and change subscription dates
 */
function companyAccess(user, authSource) {
  const role = user?.role;
  if (authSource === 'portal') {
    if (role === ROLES.SUPER_ADMIN) return { all: true, isManager: true };
    const canView = [ROLES.GROUP_ADMIN, ROLES.COMPANY_ADMIN].includes(role);
    return {
      all: false,
      isManager: role === ROLES.GROUP_ADMIN,
      hrmsTenantIds: canView ? hrmsTenantScope(user, authSource) || [] : [],
    };
  }
  if (role === 'ADMIN') return { all: true, isManager: true };
  if (role === 'COMPANY_ADMIN' && user.company_id) {
    return { all: false, isManager: false, localCompanyId: Number(user.company_id) };
  }
  return { all: false, isManager: false };
}

function canAccessCompany(access, company) {
  if (access.all) return true;
  if (access.localCompanyId && access.localCompanyId === Number(company.id)) return true;
  const tid = company.hrms_tenant_id ? Number(company.hrms_tenant_id) : null;
  return !!(tid && access.hrmsTenantIds?.includes(tid));
}

/** SQL condition limiting `alias`.id to accessible companies; null = no access at all. */
function companyAccessFilter(access, alias = 'c') {
  if (access.all) return { sql: '1 = 1', params: [] };
  const conds = [];
  const params = [];
  if (access.localCompanyId) {
    conds.push(`${alias}.id = ?`);
    params.push(access.localCompanyId);
  }
  if (access.hrmsTenantIds?.length) {
    conds.push(`${alias}.hrms_tenant_id IN (?)`);
    params.push(access.hrmsTenantIds);
  }
  return conds.length ? { sql: `(${conds.join(' OR ')})`, params } : null;
}

// ---------- validation ----------

function validateVersion(data) {
  if (!data.company_name) throw httpError(400, 'company_name is required');
  if (!data.email) throw httpError(400, 'email is required');
  if (!EMAIL_RE.test(data.email)) throw httpError(400, 'email is not valid');
  if (data.subscription_start && data.subscription_end && data.subscription_end < data.subscription_start) {
    throw httpError(400, 'subscription_end must be on or after subscription_start');
  }
}

function validateAdminPassword(password, confirm) {
  if (!password) throw httpError(400, 'admin_password is required');
  if (String(password).length < MIN_PASSWORD) {
    throw httpError(400, `admin_password must be at least ${MIN_PASSWORD} characters`);
  }
  if (String(password) !== String(confirm ?? '')) {
    throw httpError(400, 'admin_password and confirm_password do not match');
  }
}

async function assertAdminEmailFree(conn, email, excludeUserId = null) {
  const [rows] = await conn.query(
    `SELECT id FROM users
     WHERE (LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)) AND id <> ?`,
    [email, email, excludeUserId || 0]
  );
  if (rows.length) throw httpError(409, `A user with email ${email} already exists`);
}

async function assertCompanyNameFree(conn, name, excludeCompanyId = null) {
  const [rows] = await conn.query(
    `SELECT cv.company_id FROM company_versions cv
     JOIN companies c ON c.id = cv.company_id AND c.is_active = 1
     WHERE cv.effective_to IS NULL AND LOWER(cv.company_name) = LOWER(?) AND cv.company_id <> ?`,
    [name, excludeCompanyId || 0]
  );
  if (rows.length) throw httpError(409, `Company "${name}" already exists`);
}

// ---------- read ----------

function formatVersion(v) {
  return {
    version_id: v.id,
    company_name: v.company_name,
    legal_name: v.legal_name,
    email: v.email,
    address: v.address,
    logo_url: v.logo,
    subscription_start: v.subscription_start,
    subscription_end: v.subscription_end,
    effective_from: v.effective_from,
    effective_to: v.effective_to,
    remarks: v.remarks,
    created_by: v.created_by,
    created_at: v.created_at,
  };
}

/** Default list/detail view = latest version. Pass as_of=YYYY-MM-DD for a point-in-time view. */
function resolveAsOf(versions, queryAsOf) {
  const explicit = parseDate(queryAsOf, 'as_of');
  if (explicit) return { asOf: explicit, mode: 'AS_OF' };
  if (!versions.length) return { asOf: today(), mode: 'LATEST' };
  return { asOf: String(versions[versions.length - 1].effective_from).slice(0, 10), mode: 'LATEST' };
}

function shapeCompany(company, versions, asOf, mode = 'AS_OF') {
  const { current, upcoming } = resolveVersion(versions, asOf);
  const shown = mode === 'LATEST' && versions.length
    ? versions[versions.length - 1]
    : (current || upcoming);
  const effectiveStatus = mode === 'LATEST'
    ? 'LATEST'
    : (current ? 'EFFECTIVE' : 'NOT_YET_EFFECTIVE');
  return {
    id: company.id,
    source: company.source,
    hrms_tenant_id: company.hrms_tenant_id ? Number(company.hrms_tenant_id) : null,
    is_active: !!company.is_active,
    as_of: asOf,
    view: mode === 'LATEST' ? 'latest' : 'as_of',
    effective_status: effectiveStatus,
    subscription_status: subscriptionStatus(shown, asOf),
    ...(shown ? formatVersion(shown) : {}),
    admin: company.admin_user_id
      ? { id: company.admin_user_id, name: company.admin_name, email: company.admin_email }
      : null,
    upcoming_change: mode === 'AS_OF' && current && upcoming
      ? { version_id: upcoming.id, effective_from: upcoming.effective_from, remarks: upcoming.remarks }
      : null,
    created_by: company.created_by,
    created_at: company.created_at,
    updated_at: company.updated_at,
  };
}

const COMPANY_SELECT = `
  SELECT c.*, u.full_name AS admin_name, u.email AS admin_email
  FROM companies c
  LEFT JOIN users u ON u.id = c.admin_user_id`;

async function listCompanies(user, authSource, query = {}) {
  const filter = companyAccessFilter(companyAccess(user, authSource));
  if (!filter) return [];

  let sql = `${COMPANY_SELECT} WHERE ${filter.sql}`;
  if (!isTruthy(query.include_inactive)) sql += ' AND c.is_active = 1';

  const [companies] = await pool.query(sql, filter.params);
  const versions = await loadVersions(pool, VERSION_TABLE.table, VERSION_TABLE.fk, companies.map((c) => c.id));
  let result = companies.map((c) => {
    const list = versions.get(c.id) || [];
    const { asOf, mode } = resolveAsOf(list, query.as_of);
    return shapeCompany(c, list, asOf, mode);
  });

  const search = cleanText(query.search)?.toLowerCase();
  if (search) {
    result = result.filter((c) =>
      [c.company_name, c.legal_name, c.email].some((v) => v && v.toLowerCase().includes(search))
    );
  }
  return result.sort((a, b) => String(a.company_name).localeCompare(String(b.company_name)));
}

async function loadAccessibleCompany(conn, id, access) {
  const [rows] = await conn.query(`${COMPANY_SELECT} WHERE c.id = ?`, [id]);
  if (!rows.length || !canAccessCompany(access, rows[0])) throw httpError(404, 'Company not found');
  return rows[0];
}

async function loadCompanyVersions(conn, companyId) {
  return (await loadVersions(conn, VERSION_TABLE.table, VERSION_TABLE.fk, [companyId])).get(companyId) || [];
}

async function getCompany(id, user, authSource, query = {}) {
  const company = await loadAccessibleCompany(pool, id, companyAccess(user, authSource));
  const versions = await loadCompanyVersions(pool, company.id);
  const { asOf, mode } = resolveAsOf(versions, query.as_of);
  return {
    ...shapeCompany(company, versions, asOf, mode),
    versions: versions.map(formatVersion).reverse(),
  };
}

// ---------- create ----------

async function createCompany(body, file, user, authSource) {
  try {
    const access = companyAccess(user, authSource);
    if (!access.isManager) throw httpError(403, 'Not allowed to add companies');

    const data = {};
    for (const f of TEXT_FIELDS) data[f] = cleanText(body[f]) ?? null;
    for (const f of SUBSCRIPTION_FIELDS) data[f] = parseDate(body[f], f);
    data.logo = logoPathFor(file);
    const effectiveFrom = parseDate(body.effective_date, 'effective_date') || today();

    let hrmsTenantId = null;
    if (cleanText(body.hrms_tenant_id)) {
      hrmsTenantId = Number(body.hrms_tenant_id);
      if (!hrmsTenantId) throw httpError(400, 'hrms_tenant_id must be a number');
      const hrms = await getHrmsTenantForForm(hrmsTenantId, user, authSource);
      for (const f of [...TEXT_FIELDS, ...SUBSCRIPTION_FIELDS]) data[f] = data[f] ?? hrms[f] ?? null;
      data.logo = data.logo || hrms.logo_url;
    } else if (!access.all) {
      throw httpError(403, 'Group Admin can only add companies fetched from HRMS');
    }
    data.legal_name = data.legal_name || data.company_name;
    validateVersion(data);

    const adminName = cleanText(body.admin_name);
    const adminEmail = cleanText(body.admin_email)?.toLowerCase();
    if (!adminName) throw httpError(400, 'admin_name is required');
    if (!adminEmail) throw httpError(400, 'admin_email is required');
    if (!EMAIL_RE.test(adminEmail)) throw httpError(400, 'admin_email is not valid');
    validateAdminPassword(body.admin_password, body.confirm_password);

    const actor = actorLabel(user);
    const conn = await pool.getConnection();
    let companyId;
    try {
      await conn.beginTransaction();

      if (hrmsTenantId) {
        const [linked] = await conn.query('SELECT id FROM companies WHERE hrms_tenant_id = ?', [hrmsTenantId]);
        if (linked.length) throw httpError(409, `This HRMS company is already added (company id ${linked[0].id})`);
      }
      await assertCompanyNameFree(conn, data.company_name);
      await assertAdminEmailFree(conn, adminEmail);

      const [userResult] = await conn.query(
        `INSERT INTO users (username, email, full_name, password_encrypted, role)
         VALUES (?, ?, ?, ?, 'COMPANY_ADMIN')`,
        [adminEmail, adminEmail, adminName, encryptPassword(body.admin_password)]
      );
      const adminUserId = userResult.insertId;

      const isActive = parseBool(body.is_active, 'is_active');
      const [companyResult] = await conn.query(
        `INSERT INTO companies (source, hrms_tenant_id, admin_user_id, is_active, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [hrmsTenantId ? 'HRMS' : 'MANUAL', hrmsTenantId, adminUserId, isActive === false ? 0 : 1, actor]
      );
      companyId = companyResult.insertId;

      await conn.query('UPDATE users SET company_id = ? WHERE id = ?', [companyId, adminUserId]);
      await insertFirstVersion(conn, {
        ...VERSION_TABLE,
        parentId: companyId,
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

    return getCompany(companyId, user, authSource, { as_of: effectiveFrom });
  } catch (err) {
    removeUploadedFile(file);
    throw err;
  }
}

// ---------- update ----------

async function applyAdminChanges(conn, company, body) {
  const nameSent = body.admin_name !== undefined;
  const emailSent = body.admin_email !== undefined;
  const name = cleanText(body.admin_name);
  const email = cleanText(body.admin_email)?.toLowerCase();
  const password = body.admin_password ? String(body.admin_password) : null;
  if (!nameSent && !emailSent && !password) return false;

  if (emailSent && email && !EMAIL_RE.test(email)) throw httpError(400, 'admin_email is not valid');
  if (password) validateAdminPassword(password, body.confirm_password);

  if (!company.admin_user_id) {
    if (!name || !email || !password) {
      throw httpError(400, 'Company has no admin — admin_name, admin_email and admin_password are required');
    }
    await assertAdminEmailFree(conn, email);
    const [result] = await conn.query(
      `INSERT INTO users (username, email, full_name, password_encrypted, role, company_id)
       VALUES (?, ?, ?, ?, 'COMPANY_ADMIN', ?)`,
      [email, email, name, encryptPassword(password), company.id]
    );
    await conn.query('UPDATE companies SET admin_user_id = ? WHERE id = ?', [result.insertId, company.id]);
    return true;
  }

  const [[current]] = await conn.query(
    'SELECT full_name, email FROM users WHERE id = ?',
    [company.admin_user_id]
  );
  const sets = [];
  const params = [];
  if (nameSent && name && name !== current.full_name) {
    sets.push('full_name = ?');
    params.push(name);
  }
  if (emailSent && email && email !== String(current.email || '').toLowerCase()) {
    await assertAdminEmailFree(conn, email, company.admin_user_id);
    sets.push('email = ?', 'username = ?');
    params.push(email, email);
  }
  if (password) {
    sets.push('password_encrypted = ?');
    params.push(encryptPassword(password));
  }
  if (!sets.length) return false;
  await conn.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, company.admin_user_id]);
  return true;
}

/** Edit with effective date — accepts a full form (all fields) or only the fields that change. */
async function updateCompany(id, body, file, user, authSource) {
  try {
    const access = companyAccess(user, authSource);
    const company = await loadAccessibleCompany(pool, id, access);
    const versions = await loadCompanyVersions(pool, company.id);
    const latest = versions[versions.length - 1];
    if (!latest) throw httpError(500, 'Company has no version history');

    // Accept effective_date or effective_from (frontend often sends the latter).
    const effectiveDate = parseDate(body.effective_date ?? body.effective_from, 'effective_date') || today();
    const isActive = parseBool(body.is_active, 'is_active');
    const remarks = body.remarks !== undefined ? cleanText(body.remarks) : undefined;

    const changes = {};
    for (const f of TEXT_FIELDS) if (body[f] !== undefined) changes[f] = cleanText(body[f]);
    for (const f of SUBSCRIPTION_FIELDS) if (body[f] !== undefined) changes[f] = parseDate(body[f], f);
    if (file) changes.logo = logoPathFor(file);
    else if (isTruthy(body.remove_logo)) changes.logo = null;

    // Form edit always updates the latest version (list API shows latest).
    const base = latest;
    const baseFrom = String(base.effective_from).slice(0, 10);
    const fieldChanged = changedFields(changes, base);
    const dateChanged = effectiveDate !== baseFrom;
    const remarksChanged = remarks !== undefined && remarks !== (base.remarks ?? null);

    if (!access.isManager) {
      const subChanges = fieldChanged.filter((k) => SUBSCRIPTION_FIELDS.includes(k));
      if (subChanges.length) {
        throw httpError(403, 'Only platform admins can change subscription dates');
      }
    }

    const shouldSaveVersion = fieldChanged.length > 0 || dateChanged || remarksChanged;
    let merged = null;
    if (shouldSaveVersion) {
      merged = { ...Object.fromEntries(VERSION_FIELDS.map((f) => [f, base[f]])), ...changes };
      merged.legal_name = merged.legal_name || merged.company_name;
      validateVersion(merged);
    }

    const actor = actorLabel(user);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (merged) {
        if (changes.company_name !== undefined && changes.company_name !== base.company_name) {
          await assertCompanyNameFree(conn, merged.company_name, company.id);
        }
        await updateLatestVersion(conn, {
          ...VERSION_TABLE,
          parentId: company.id,
          fields: VERSION_FIELDS,
          data: merged,
          effectiveDate,
          remarks: remarks !== undefined ? remarks : base.remarks,
          actor,
        });
      }

      const adminChanged = await applyAdminChanges(conn, company, body);

      let activeChanged = false;
      if (isActive !== undefined && isActive !== !!company.is_active) {
        if (!access.isManager) throw httpError(403, 'Only platform admins can activate / deactivate a company');
        await conn.query('UPDATE companies SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, company.id]);
        activeChanged = true;
      }

      if (!merged && !adminChanged && !activeChanged) throw httpError(400, 'No changes to save');

      await conn.query('UPDATE companies SET updated_at = NOW() WHERE id = ?', [company.id]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Return latest view (same as list API) so response effective_from matches the list.
    return getCompany(company.id, user, authSource);
  } catch (err) {
    removeUploadedFile(file);
    throw err;
  }
}

async function cancelScheduledVersion(companyId, versionId, user, authSource) {
  const company = await loadAccessibleCompany(pool, companyId, companyAccess(user, authSource));
  await cancelVersion({ ...VERSION_TABLE, parentId: company.id, versionId });
  return getCompany(company.id, user, authSource);
}

module.exports = {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  cancelScheduledVersion,
  companyAccess,
  companyAccessFilter,
  loadAccessibleCompany,
  loadCompanyVersions,
  LOGO_DISK_DIR,
};
