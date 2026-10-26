const express = require('express');
const router = express.Router();
const {
  login,
  register,
  listUsers,
  decodeUserPassword,
  encryptPassword,
  decryptPassword,
} = require('../services/authService');
const { portalLogin, getPortalVisiblePassword, AUTH_SOURCE } = require('../services/sharedAuthService');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   - name: 00 Auth
 *     description: Dual login — inventory local OR portal (redirect token)
 */

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [00 Auth]
 *     summary: Inventory local login (username + password → JWT)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string, example: admin }
 *               password: { type: string, example: admin123 }
 *     responses:
 *       200:
 *         description: Inventory JWT token
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const result = await login(username, password);
    res.json({ ...result, auth_source: 'inventory' });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/portal-login:
 *   post:
 *     tags: [00 Auth]
 *     summary: Portal login (email/mobile + password — tenant users)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [login, password]
 *             properties:
 *               login: { type: string, example: admin@example.com }
 *               password: { type: string, example: password }
 *     responses:
 *       200:
 *         description: Portal JWT with tenant role
 */
router.post('/portal-login', async (req, res) => {
  try {
    const { login: loginId, password } = req.body;
    if (!loginId || !password) {
      return res.status(400).json({ error: 'login and password are required' });
    }
    const result = await portalLogin(loginId, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     tags: [00 Auth]
 *     summary: Register inventory local user
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *               email: { type: string }
 *               full_name: { type: string }
 *               role: { type: string, enum: [ADMIN, COMPANY_ADMIN, USER], default: USER }
 *     responses:
 *       201:
 *         description: Created
 */
router.post('/register', async (req, res) => {
  try {
    const user = await register(req.body);
    res.status(201).json({ message: 'User registered', user, auth_source: 'inventory' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [00 Auth]
 *     summary: Current user (inventory JWT or portal token)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: { ...req.user, auth_source: req.authSource },
    auth_source: req.authSource,
  });
});

/**
 * @swagger
 * /api/auth/users:
 *   get:
 *     tags: [00 Auth]
 *     summary: List inventory local users (Admin)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.authSource === AUTH_SOURCE) {
      return res.json({ message: 'Portal users are managed in main app', users: [] });
    }
    const users = await listUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/users/{id}/decode-password:
 *   get:
 *     tags: [00 Auth]
 *     summary: Decode inventory local user password (Admin) — only legacy AES; bcrypt cannot be decoded
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Plain password
 */
router.get('/users/:id/decode-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.authSource === AUTH_SOURCE) {
      return res.status(400).json({ error: 'Use portal visible-password API for portal users' });
    }
    const data = await decodeUserPassword(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/portal-users/{id}/visible-password:
 *   get:
 *     tags: [00 Auth]
 *     summary: Portal user plain password (visible_password — admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Plain password if stored
 */
router.get('/portal-users/:id/visible-password', requireAuth, async (req, res) => {
  try {
    if (req.authSource !== AUTH_SOURCE) {
      return res.status(400).json({ error: 'Login with portal token to view portal passwords' });
    }
    const data = await getPortalVisiblePassword(req.user, req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.message.includes('Not allowed') ? 403 : 400).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/auth/password-tool:
 *   post:
 *     tags: [00 Auth]
 *     summary: Hash (bcrypt) or decrypt legacy AES text (inventory Admin)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, text]
 *             properties:
 *               action: { type: string, enum: [encrypt, hash, decrypt], description: 'encrypt/hash = bcrypt; decrypt = legacy AES only' }
 *               text: { type: string }
 *     responses:
 *       200:
 *         description: Result
 */
router.post('/password-tool', requireAuth, requireAdmin, (req, res) => {
  try {
    if (req.authSource === AUTH_SOURCE) {
      return res.status(400).json({ error: 'Use inventory local admin for password tool' });
    }
    const { action, text } = req.body;
    if (!action || !text) {
      return res.status(400).json({ error: 'action and text are required' });
    }
    if (action === 'encrypt') {
      return res.json({ action, input: text, result: encryptPassword(text) });
    }
    if (action === 'decrypt') {
      return res.json({ action, input: text, result: decryptPassword(text) });
    }
    res.status(400).json({ error: 'action must be encrypt or decrypt' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
