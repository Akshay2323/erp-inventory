const { resolveTenantScope } = require('../services/tenantScope');

function attachTenantScope(req, res, next) {
  try {
    req.tenantScope = resolveTenantScope(req.user, req.authSource, req.query);
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

module.exports = { attachTenantScope };
