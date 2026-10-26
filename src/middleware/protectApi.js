const { requireAuth } = require('./auth');

const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/portal-login',
  '/api/auth/register',
]);

function protectApi(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  return requireAuth(req, res, next);
}

module.exports = { protectApi, PUBLIC_PATHS };
