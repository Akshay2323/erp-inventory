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

module.exports = {
  getHrmsStatus,
  listHrmsTenants,
  getHrmsTenantForForm,
  listHrmsBranches,
  getHrmsBranchForForm,
  hrmsTenantScope,
};
