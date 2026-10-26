const pool = require('../../config/db');
const { ROLES } = require('../../config/roles');
const { permissionsFor } = require('../../config/permissions');
const { hrmsTenantScope } = require('../hrmsService');
const { httpError, actorLabel } = require('../common');

/** Inventory company ids the user may work with; null = all companies. */
async function scopedCompanyIds(user, authSource) {
  if (authSource === 'portal') {
    if (user?.role === ROLES.SUPER_ADMIN) return null;
    const tenantIds = hrmsTenantScope(user, authSource) || [];
    if (!tenantIds.length) return [];
    const [rows] = await pool.query('SELECT id FROM companies WHERE hrms_tenant_id IN (?)', [tenantIds]);
    return rows.map((r) => r.id);
  }
  if (user?.role === 'ADMIN') return null;
  return user?.company_id ? [Number(user.company_id)] : [];
}

/** Per-request context for one module (clients or vendors). */
async function buildPartyContext(cfg, user, authSource) {
  const perms = permissionsFor(user?.role, cfg.key);
  const companyIds = await scopedCompanyIds(user, authSource);
  const ctx = {
    cfg,
    user,
    authSource,
    role: user?.role || null,
    actor: actorLabel(user),
    companyIds,
    permissions: [...perms].map((a) => `${cfg.key}.${a}`),
    can: (action) => perms.has(action),
    assert(action) {
      if (!perms.has(action)) throw httpError(403, `Permission ${cfg.key}.${action} required`);
    },
    canSeeCompany: (companyId) => companyIds === null || companyIds.includes(Number(companyId)),
    /** SQL filter on a company_id column. */
    companyFilter(column) {
      if (companyIds === null) return { sql: '1 = 1', params: [] };
      if (!companyIds.length) return { sql: '1 = 0', params: [] };
      return { sql: `${column} IN (?)`, params: [companyIds] };
    },
  };
  return ctx;
}

async function assertCompanyUsable(ctx, companyId) {
  const id = Number(companyId);
  if (!id) throw httpError(400, 'company_id is required');
  if (!ctx.canSeeCompany(id)) throw httpError(404, 'Company not found');
  const [rows] = await pool.query('SELECT id, is_active FROM companies WHERE id = ?', [id]);
  if (!rows.length) throw httpError(404, 'Company not found');
  if (!rows[0].is_active) throw httpError(400, 'Company is inactive');
  return rows[0];
}

module.exports = { buildPartyContext, assertCompanyUsable, scopedCompanyIds };
