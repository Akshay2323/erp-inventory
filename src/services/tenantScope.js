const { ROLES } = require('../config/roles');

/**
 * Resolve which hrms_db.tenants IDs the current request may access.
 * Portal users → scoped by role + accessible_company_ids.
 * Local inventory login → optional ?company_id= filter (standalone = all data).
 */
function resolveTenantScope(user, authSource, query = {}) {
  const requested = query.company_id ? Number(query.company_id) : null;

  if (authSource === 'portal') {
    const role = user?.role;
    const accessible = (user?.accessible_company_ids || []).map(Number).filter(Boolean);
    const companyId = user?.company_id ? Number(user.company_id) : null;

    if (role === ROLES.SUPER_ADMIN) {
      return {
        mode: 'super',
        tenantIds: requested ? [requested] : null,
        activeTenantId: requested || null,
        isMultiTenant: true,
      };
    }

    const allowed = accessible.length ? accessible : (companyId ? [companyId] : []);

    if (requested) {
      if (allowed.length && !allowed.includes(requested)) {
        const err = new Error('Not allowed to access this company');
        err.status = 403;
        throw err;
      }
      return {
        mode: 'scoped',
        tenantIds: [requested],
        activeTenantId: requested,
        isMultiTenant: true,
      };
    }

    return {
      mode: 'scoped',
      tenantIds: allowed.length ? allowed : (companyId ? [companyId] : []),
      activeTenantId: companyId,
      isMultiTenant: true,
    };
  }

  // Local inventory login (standalone or with optional company filter)
  return {
    mode: 'local',
    tenantIds: requested ? [requested] : null,
    activeTenantId: requested || null,
    isMultiTenant: !!requested,
  };
}

function tenantFilter(scope, column = 'tenant_id') {
  if (!scope?.tenantIds?.length) return { sql: '', params: [] };
  if (scope.tenantIds.length === 1) {
    return { sql: ` AND ${column} = ?`, params: [scope.tenantIds[0]] };
  }
  const placeholders = scope.tenantIds.map(() => '?').join(', ');
  return { sql: ` AND ${column} IN (${placeholders})`, params: [...scope.tenantIds] };
}

function appendFilter(baseSql, baseParams, filter) {
  return { sql: `${baseSql}${filter.sql}`, params: [...baseParams, ...filter.params] };
}

function getWriteTenantId(scope, authSource) {
  if (scope?.activeTenantId) return scope.activeTenantId;
  if (authSource === 'portal') {
    const err = new Error('company_id is required for portal users (query param or user company)');
    err.status = 400;
    throw err;
  }
  return null;
}

function assertRowTenant(scope, row, authSource) {
  if (!scope?.tenantIds?.length) return;
  const tid = row?.tenant_id != null ? Number(row.tenant_id) : null;
  if (tid == null) {
    if (authSource === 'portal') {
      const err = new Error('Record is not linked to a company');
      err.status = 403;
      throw err;
    }
    return;
  }
  if (!scope.tenantIds.includes(tid)) {
    const err = new Error('Not allowed to access this company data');
    err.status = 403;
    throw err;
  }
}

module.exports = {
  resolveTenantScope,
  tenantFilter,
  appendFilter,
  getWriteTenantId,
  assertRowTenant,
};
