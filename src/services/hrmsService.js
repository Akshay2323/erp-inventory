const sharedPool = require('../config/sharedDb');
const { ROLES } = require('../config/roles');
const { httpError } = require('./common');

const USER_MODEL = 'App\\Models\\User';

function isHrmsEnabled() {
  return String(process.env.HRMS_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function hrmsLogoUrl(logoPath) {
  if (!logoPath) return null;
  if (/^https?:\/\//i.test(logoPath)) return logoPath;
  const base = (process.env.HRMS_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/storage/${logoPath.replace(/^\/+/, '')}` : null;
}

/**
 * Which HRMS tenants the user may fetch from.
 * null = all tenants, [] = none, [ids] = only these.
 */
function hrmsTenantScope(user, authSource) {
  if (authSource === 'portal') {
    if (user?.role === ROLES.SUPER_ADMIN) return null;
    const ids = (user?.accessible_company_ids || []).map(Number).filter(Boolean);
    if (!ids.length && user?.company_id) ids.push(Number(user.company_id));
    return ids;
  }
  return user?.role === 'ADMIN' ? null : [];
}

async function getHrmsStatus(user, authSource) {
  if (!isHrmsEnabled()) {
    return { available: false, reason: 'HRMS integration is disabled (HRMS_ENABLED=false)' };
  }
  try {
    await sharedPool.query('SELECT 1 FROM tenants LIMIT 1');
  } catch (err) {
    return { available: false, reason: `HRMS database not reachable: ${err.message}` };
  }
  const scope = hrmsTenantScope(user, authSource);
  if (scope) {
    const [rows] = scope.length
      ? await sharedPool.query('SELECT id FROM tenants WHERE id IN (?) AND is_platform = 0', [scope])
      : [[]];
    if (!rows.length) return { available: false, reason: 'Your account has no HRMS companies' };
  }
  return { available: true, reason: null };
}

async function assertHrmsAvailable(user, authSource) {
  const status = await getHrmsStatus(user, authSource);
  if (!status.available) throw httpError(400, status.reason);
}

async function listHrmsTenants(user, authSource, { search } = {}) {
  await assertHrmsAvailable(user, authSource);
  const scope = hrmsTenantScope(user, authSource);

  let sql = `SELECT id, company_name, legal_name, email, status, parent_tenant_id,
                    subscription_start, subscription_end
             FROM tenants WHERE is_platform = 0`;
  const params = [];
  if (scope) {
    sql += ` AND id IN (${scope.map(() => '?').join(', ')})`;
    params.push(...scope);
  }
  if (search) {
    sql += ' AND (company_name LIKE ? OR legal_name LIKE ? OR email LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY company_name';

  const [rows] = await sharedPool.query(sql, params);
  return rows;
}

async function findHrmsCompanyAdmin(tenantId) {
  const [rows] = await sharedPool.query(
    `SELECT u.id, u.name, u.email
     FROM users u
     JOIN model_has_roles mhr ON mhr.model_id = u.id AND mhr.model_type = ? AND mhr.tenant_id = ?
     JOIN roles r ON r.id = mhr.role_id AND r.name = ?
     WHERE u.tenant_id = ? AND u.status = 'active'
     ORDER BY u.id
     LIMIT 1`,
    [USER_MODEL, tenantId, ROLES.COMPANY_ADMIN, tenantId]
  );
  return rows[0] || null;
}

/** HRMS tenant mapped to Company form fields (password is never fetched). */
async function getHrmsTenantForForm(tenantId, user, authSource) {
  await assertHrmsAvailable(user, authSource);
  const id = Number(tenantId);
  const scope = hrmsTenantScope(user, authSource);
  if (!id) throw httpError(400, 'Invalid HRMS company id');
  if (scope && !scope.includes(id)) throw httpError(403, 'Not allowed to fetch this HRMS company');

  const [rows] = await sharedPool.query(
    'SELECT * FROM tenants WHERE id = ? AND is_platform = 0',
    [id]
  );
  if (!rows.length) throw httpError(404, 'HRMS company not found');
  const t = rows[0];
  const admin = await findHrmsCompanyAdmin(id);

  return {
    hrms_tenant_id: Number(t.id),
    company_name: t.company_name,
    legal_name: t.legal_name,
    email: t.email,
    address: t.address,
    logo_path: t.logo,
    logo_url: hrmsLogoUrl(t.logo),
    subscription_start: t.subscription_start,
    subscription_end: t.subscription_end,
    status: t.status,
    admin_name: admin?.name || null,
    admin_email: admin?.email || null,
  };
}

async function assertHrmsTenantAllowed(tenantId, user, authSource) {
  await assertHrmsAvailable(user, authSource);
  const scope = hrmsTenantScope(user, authSource);
  if (scope && !scope.includes(Number(tenantId))) {
    throw httpError(403, 'Not allowed to fetch from this HRMS company');
  }
}

/** HRMS branches belong to a company via company_id (falls back to tenant_id). */
const HRMS_BRANCH_OF_COMPANY = 'deleted_at IS NULL AND COALESCE(company_id, tenant_id) = ?';

async function listHrmsBranches(tenantId, user, authSource) {
  await assertHrmsTenantAllowed(tenantId, user, authSource);
  const [rows] = await sharedPool.query(
    `SELECT id, name, code, city, state, status
     FROM branches WHERE ${HRMS_BRANCH_OF_COMPANY}
     ORDER BY name`,
    [tenantId]
  );
  return rows;
}

/** HRMS branch mapped to Branch form fields. */
async function getHrmsBranchForForm(branchId, tenantId, user, authSource) {
  await assertHrmsTenantAllowed(tenantId, user, authSource);
  const [rows] = await sharedPool.query(
    `SELECT * FROM branches WHERE id = ? AND ${HRMS_BRANCH_OF_COMPANY}`,
    [branchId, tenantId]
  );
  if (!rows.length) throw httpError(404, 'HRMS branch not found for this company');
  const b = rows[0];
  return {
    hrms_branch_id: Number(b.id),
    name: b.name,
    code: b.code,
    address: b.address,
    city: b.city,
    state: b.state,
    pincode: b.pincode,
    phone: b.phone,
    email: b.email,
    contact_person_name: b.contact_person_name,
    status: String(b.status).toLowerCase() === 'active' ? 'ACTIVE' : 'INACTIVE',
    latitude: b.latitude != null ? Number(b.latitude) : null,
    longitude: b.longitude != null ? Number(b.longitude) : null,
  };
}

let localDb = null;
function getLocalPool() {
  if (!localDb) localDb = require('../config/db');
  return localDb;
}

async function resolveHrmsTenantId(companyId) {
  if (!companyId) return null;
  const cId = Number(companyId);
  if (Number.isNaN(cId) || cId <= 0) return null;
  try {
    const localPool = getLocalPool();
    const [rows] = await localPool.query('SELECT hrms_tenant_id FROM companies WHERE id = ?', [cId]);
    if (rows.length && rows[0].hrms_tenant_id) {
      return Number(rows[0].hrms_tenant_id);
    }
  } catch {
    // ignore
  }
  return cId;
}

/**
 * Fetch sales person employees (employee codes, names, department, designation) from HRMS DB.
 * Only returns active employees who belong to Sales department or have a Sales/Salesman designation.
 */
async function listHrmsSalesPersons(user, authSource, options = {}) {
  await assertHrmsAvailable(user, authSource);
  const scope = hrmsTenantScope(user, authSource);

  let tenantId = null;
  if (options.company_id) {
    tenantId = await resolveHrmsTenantId(options.company_id);
  } else if (options.tenant_id || options.hrms_tenant_id) {
    tenantId = Number(options.tenant_id || options.hrms_tenant_id);
  }

  if (tenantId && scope && !scope.includes(tenantId)) {
    throw httpError(403, 'Not allowed to fetch from this HRMS company');
  }

  let sql = `
    SELECT
      e.id,
      e.employee_code,
      e.first_name,
      e.last_name,
      TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) AS full_name,
      e.email,
      e.mobile,
      e.gender,
      e.status,
      COALESCE(e.company_id, e.tenant_id) AS company_id,
      COALESCE(e.tenant_id, e.company_id) AS tenant_id,
      t.company_name AS tenant_name,
      e.branch_id,
      b.name AS branch_name,
      COALESCE(e.department_id, jd.department_id) AS department_id,
      d.name AS department_name,
      d.code AS department_code,
      COALESCE(e.designation_id, jd.designation_id) AS designation_id,
      des.name AS designation_name,
      des.code AS designation_code,
      u.id AS user_id
    FROM employees e
    LEFT JOIN employee_job_details jd ON jd.employee_id = e.id
    LEFT JOIN departments d ON d.id = COALESCE(e.department_id, jd.department_id)
    LEFT JOIN designations des ON des.id = COALESCE(e.designation_id, jd.designation_id)
    LEFT JOIN branches b ON b.id = e.branch_id
    LEFT JOIN tenants t ON t.id = COALESCE(e.company_id, e.tenant_id)
    LEFT JOIN users u ON LOWER(u.email) = LOWER(e.email) AND u.tenant_id = COALESCE(e.tenant_id, e.company_id)
    WHERE e.deleted_at IS NULL
  `;
  const params = [];

  const designationOnly = String(options.designation_only).toLowerCase() === 'true' ||
                          String(options.only_salesman).toLowerCase() === 'true';
  if (designationOnly) {
    sql += ` AND (LOWER(des.name) LIKE '%sale%' OR LOWER(des.code) LIKE '%sale%')`;
  } else {
    sql += ` AND (
      LOWER(des.name) LIKE '%sale%'
      OR LOWER(des.code) LIKE '%sale%'
      OR LOWER(d.name) LIKE '%sale%'
      OR LOWER(d.code) LIKE '%sale%'
    )`;
  }

  if (tenantId) {
    sql += ` AND (e.tenant_id = ? OR e.company_id = ?)`;
    params.push(tenantId, tenantId);
  } else if (scope) {
    if (!scope.length) return [];
    sql += ` AND (e.tenant_id IN (?) OR e.company_id IN (?))`;
    params.push(scope, scope);
  }

  if (options.branch_id) {
    sql += ` AND e.branch_id = ?`;
    params.push(Number(options.branch_id));
  }

  const status = (options.status || 'active').trim().toLowerCase();
  if (status !== 'all') {
    sql += ` AND LOWER(e.status) = ?`;
    params.push(status);
  }

  if (options.search) {
    const like = `%${options.search.trim()}%`;
    sql += ` AND (e.employee_code LIKE ? OR e.first_name LIKE ? OR e.last_name LIKE ? OR e.email LIKE ? OR e.mobile LIKE ?)`;
    params.push(like, like, like, like, like);
  }

  sql += ` ORDER BY e.employee_code ASC`;

  const [rows] = await sharedPool.query(sql, params);

  if (String(options.codes_only).toLowerCase() === 'true' || options.format === 'codes') {
    return rows.map((r) => r.employee_code).filter(Boolean);
  }

  return rows.map((r) => ({
    id: Number(r.id),
    employee_code: r.employee_code,
    full_name: r.full_name || null,
    name: r.full_name || null,
    first_name: r.first_name || null,
    last_name: r.last_name || null,
    email: r.email || null,
    mobile: r.mobile || null,
    gender: r.gender || null,
    status: r.status || null,
    tenant_id: r.tenant_id ? Number(r.tenant_id) : null,
    company_id: r.company_id ? Number(r.company_id) : null,
    company_name: r.tenant_name || null,
    branch_id: r.branch_id ? Number(r.branch_id) : null,
    branch_name: r.branch_name || null,
    department_id: r.department_id ? Number(r.department_id) : null,
    department_name: r.department_name || null,
    department_code: r.department_code || null,
    designation_id: r.designation_id ? Number(r.designation_id) : null,
    designation_name: r.designation_name || null,
    designation_code: r.designation_code || null,
    user_id: r.user_id ? Number(r.user_id) : null,
  }));
}

module.exports = {
  getHrmsStatus,
  listHrmsTenants,
  getHrmsTenantForForm,
  listHrmsBranches,
  getHrmsBranchForForm,
  listHrmsSalesPersons,
  hrmsTenantScope,
};

