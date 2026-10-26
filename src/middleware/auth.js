const { verifyToken, findUserById, sanitizeUser } = require('../services/authService');
const {
  validateSanctumToken,
  refreshPortalProfileFromJwt,
  isPortalPayload,
  AUTH_SOURCE,
} = require('../services/sharedAuthService');
const { ROLES, canRegisterUsers } = require('../config/roles');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query?.token) return String(req.query.token).trim();
  return null;
}

async function requireAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'Login required. Send Bearer token.' });
    }

    // Portal redirect Sanctum token: "123|plainTextToken"
    if (token.includes('|')) {
      const profile = await validateSanctumToken(token);
      if (!profile) return res.status(401).json({ error: 'Invalid or expired portal token' });
      req.user = profile;
      req.authSource = AUTH_SOURCE;
      return next();
    }

    const payload = verifyToken(token);

    // Portal login JWT
    if (isPortalPayload(payload)) {
      const profile = await refreshPortalProfileFromJwt(payload);
      if (!profile) return res.status(401).json({ error: 'Invalid or inactive portal user' });
      req.user = profile;
      req.authSource = AUTH_SOURCE;
      return next();
    }

    // Local inventory login
    const user = await findUserById(payload.id);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid or inactive user' });
    }
    req.user = { ...sanitizeUser(user), auth_source: 'inventory' };
    req.authSource = 'inventory';
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  const role = req.user?.role;
  const allowed = [ROLES.SUPER_ADMIN, ROLES.GROUP_ADMIN, ROLES.COMPANY_ADMIN, 'ADMIN', 'SUPERADMIN'];
  if (!role || !allowed.includes(role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireCanRegister(req, res, next) {
  if (req.authSource === 'inventory' && req.user?.role === 'ADMIN') return next();
  if (req.authSource === AUTH_SOURCE && canRegisterUsers(req.user?.role)) return next();
  return res.status(403).json({ error: 'Not allowed to register users' });
}

module.exports = { requireAuth, requireAdmin, requireCanRegister, extractBearer };
