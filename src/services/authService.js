const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const {
  encryptPassword, decryptPassword, verifyPasswordDetailed,
} = require('./passwordService');

const JWT_SECRET = process.env.JWT_SECRET || 'inventory-app-jwt-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

function signToken(user) {
  return jwt.sign(
    { auth_source: 'inventory', id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function findUserByUsername(username) {
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
  return rows[0] || null;
}

async function findUserById(id) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    auth_source: 'inventory',
    id: user.id,
    username: user.username,
    name: user.full_name || user.username,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    company_id: user.company_id || null,
    is_active: !!user.is_active,
    last_login: user.last_login,
    created_at: user.created_at,
  };
}

async function login(username, password) {
  const user = await findUserByUsername(username);
  if (!user || !user.is_active) {
    throw new Error('Invalid username or password');
  }
  const check = verifyPasswordDetailed(password, user.password_encrypted);
  if (!check.ok) {
    throw new Error('Invalid username or password');
  }
  // Upgrade plaintext / leftover bcrypt → AES on successful login
  if (check.needsUpgrade) {
    await pool.query('UPDATE users SET password_encrypted = ?, last_login = NOW() WHERE id = ?', [
      encryptPassword(password),
      user.id,
    ]);
  } else {
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
  }
  const token = signToken(user);
  return { token, user: sanitizeUser(user) };
}

async function register({ username, password, email, full_name, role = 'USER' }) {
  if (!username || !password) throw new Error('username and password are required');
  if (password.length < 4) throw new Error('password must be at least 4 characters');

  const existing = await findUserByUsername(username);
  if (existing) throw new Error('Username already exists');

  const encrypted = encryptPassword(password);
  const [result] = await pool.query(
    `INSERT INTO users (username, email, full_name, password_encrypted, role)
     VALUES (?, ?, ?, ?, ?)`,
    [username, email || null, full_name || null, encrypted, role]
  );
  const user = await findUserById(result.insertId);
  return sanitizeUser(user);
}

async function listUsers() {
  const [rows] = await pool.query(
    `SELECT id, username, email, full_name, role, is_active, last_login, created_at
     FROM users ORDER BY id`
  );
  return rows;
}

async function decodeUserPassword(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('User not found');
  return {
    id: user.id,
    username: user.username,
    password: decryptPassword(user.password_encrypted),
    encrypted: user.password_encrypted,
  };
}

module.exports = {
  signToken,
  verifyToken,
  login,
  register,
  listUsers,
  decodeUserPassword,
  sanitizeUser,
  findUserById,
  encryptPassword,
  decryptPassword,
};
