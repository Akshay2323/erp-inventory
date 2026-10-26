const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sharedPool = require('../config/sharedDb');
const { ROLES, PLATFORM_TENANT_ID, pickPrimaryRole, isPlatformRole } = require('../config/roles');

const JWT_SECRET = process.env.JWT_SECRET || 'inventory-app-jwt-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const USER_MODEL = 'App\\Models\\User';
const AUTH_SOURCE = 'portal';

function signPortalSession(userProfile) {
  return jwt.sign(
    {
      auth_source: AUTH_SOURCE,
      portal_user_id: userProfile.id,
      role: userProfile.role,
      tenant_id: userProfile.tenant_id,
      company_id: userProfile.company_id,
      accessible_company_ids: userProfile.accessible_company_ids,
      name: userProfile.name,
      email: userProfile.email,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

async function loadPortalUserById(userId) {
  const [rows] = await sharedPool.query('SELECT * FROM users WHERE id = ?', [userId]);
  return rows[0] || null;
}

async function resolvePortalRoles(user) {
  const roleNames = new Set();

  if (user.tenant_id) {
    const [tenantRoles] = await sharedPool.query(
      `SELECT r.name FROM roles r
       JOIN model_has_roles mhr ON mhr.role_id = r.id
       WHERE mhr.model_type = ? AND mhr.model_id = ? AND mhr.tenant_id = ?`,
      [USER_MODEL, user.id, user.tenant_id]
    );
    tenantRoles.forEach((r) => roleNames.add(r.name));
  }

  const [platformRoles] = await sharedPool.query(
    `SELECT r.name FROM roles r
     JOIN model_has_roles mhr ON mhr.role_id = r.id
     WHERE mhr.model_type = ? AND mhr.model_id = ? AND mhr.tenant_id = ?`,
    [USER_MODEL, user.id, PLATFORM_TENANT_ID]
  );
  platformRoles.forEach((r) => roleNames.add(r.name));

  return [...roleNames];
}

async function resolveCompanyId(user) {
  if (user.company_id) return Number(user.company_id);
  if (!user.tenant_id || !user.email) return user.tenant_id ? Number(user.tenant_id) : null;

  const [emp] = await sharedPool.query(
    `SELECT company_id FROM employees
     WHERE tenant_id = ? AND LOWER(email) = LOWER(?) LIMIT 1`,
    [user.tenant_id, user.email]
  );
  if (emp.length && emp[0].company_id) return Number(emp[0].company_id);
  return Number(user.tenant_id);
}

async function accessibleCompanyIds(user, role) {
  if (!user.tenant_id || user.status !== 'active') return [];

  if (role === ROLES.GROUP_ADMIN) {
    const [rows] = await sharedPool.query(
      `SELECT id FROM tenants WHERE id = ? AND is_platform = 0`,
      [user.tenant_id]
    );
    return rows.map((r) => Number(r.id));
  }

  if (role === ROLES.COMPANY_ADMIN) {
    const tenantId = Number(user.tenant_id);
    const [tenant] = await sharedPool.query('SELECT id, parent_tenant_id FROM tenants WHERE id = ?', [tenantId]);
    if (!tenant.length) return [];
    if (tenant[0].parent_tenant_id) return [tenantId];

    const [children] = await sharedPool.query(
      'SELECT id FROM tenants WHERE parent_tenant_id = ?',
      [tenantId]
    );
    const ids = children.map((c) => Number(c.id));
    return [...new Set([tenantId, ...ids])];
  }

  const cid = await resolveCompanyId(user);
  return cid ? [cid] : [];
}

async function buildPortalProfile(user) {
  const roleNames = await resolvePortalRoles(user);
  const role = pickPrimaryRole(roleNames);
  const companyId = await resolveCompanyId(user);
  const accessible_company_ids = role === ROLES.SUPER_ADMIN
    ? []
    : await accessibleCompanyIds(user, role);

  return {
    auth_source: AUTH_SOURCE,
    id: user.id,
    portal_user_id: user.id,
    name: user.name,
    email: user.email,
    mobile: user.mobile || null,
    role,
    roles: roleNames,
    tenant_id: user.tenant_id ? Number(user.tenant_id) : null,
    company_id: companyId,
    accessible_company_ids,
    is_active: user.status === 'active',
  };
}

async function validateSanctumToken(bearerToken) {
  if (!bearerToken || !bearerToken.includes('|')) return null;

  const [tokenId, plainToken] = bearerToken.split('|');
  if (!tokenId || !plainToken) return null;

  const hash = crypto.createHash('sha256').update(plainToken).digest('hex');
  const [tokens] = await sharedPool.query(
    `SELECT * FROM personal_access_tokens
     WHERE id = ? AND token = ?
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [tokenId, hash]
  );
  if (!tokens.length) return null;

  const row = tokens[0];
  const user = await loadPortalUserById(row.tokenable_id);
  if (!user || user.status !== 'active') return null;

  await sharedPool.query('UPDATE personal_access_tokens SET last_used_at = NOW() WHERE id = ?', [tokenId]);
  return buildPortalProfile(user);
}

async function findPortalUserByLogin(login) {
  const value = String(login).trim();
  const [byEmail] = await sharedPool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1',
    [value]
  );
  if (byEmail.length) return byEmail[0];

  const [byMobile] = await sharedPool.query(
    'SELECT * FROM users WHERE mobile = ? LIMIT 1',
    [value]
  );
  return byMobile[0] || null;
}

async function verifyPortalPassword(user, password) {
  const hash = String(user.password || '');
  if (!hash) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return hash === password;
  }
}

async function portalLogin(login, password) {
  const user = await findPortalUserByLogin(login);
  if (!user) throw new Error('Invalid credentials');

  const valid = await verifyPortalPassword(user, password);
  if (!valid) throw new Error('Invalid credentials');
  if (user.status !== 'active') throw new Error('Account is inactive');

  const profile = await buildPortalProfile(user);
  const token = signPortalSession(profile);
  return { token, auth_source: AUTH_SOURCE, user: profile };
}

function resolvePortalUserId(payload) {
  return payload.portal_user_id || payload.hrms_user_id;
}

function isPortalPayload(payload) {
  return payload.auth_source === AUTH_SOURCE || payload.auth_source === 'hrms';
}

async function refreshPortalProfileFromJwt(payload) {
  const userId = resolvePortalUserId(payload);
  const user = await loadPortalUserById(userId);
  if (!user || user.status !== 'active') return null;
  return buildPortalProfile(user);
}

async function getPortalVisiblePassword(requester, targetUserId) {
  const allowed = [ROLES.SUPER_ADMIN, ROLES.GROUP_ADMIN, ROLES.COMPANY_ADMIN];
  if (!allowed.includes(requester.role)) {
    throw new Error('Only Super Admin, Group Admin or Company Admin can view passwords');
  }

  const target = await loadPortalUserById(targetUserId);
  if (!target) throw new Error('User not found');

  if (requester.role !== ROLES.SUPER_ADMIN) {
    const targetProfile = await buildPortalProfile(target);
    const allowedCompanies = requester.accessible_company_ids || [];
    if (
      targetProfile.company_id &&
      allowedCompanies.length &&
      !allowedCompanies.includes(targetProfile.company_id)
    ) {
      throw new Error('Not allowed to view this user password');
    }
  }

  return {
    id: target.id,
    name: target.name,
    email: target.email,
    password: target.visible_password || null,
    note: target.visible_password
      ? 'From users.visible_password (plain text)'
      : 'No visible_password stored — reset password in admin panel to populate',
  };
}

module.exports = {
  portalLogin,
  validateSanctumToken,
  buildPortalProfile,
  refreshPortalProfileFromJwt,
  signPortalSession,
  isPlatformRole,
  getPortalVisiblePassword,
  isPortalPayload,
  AUTH_SOURCE,
};
