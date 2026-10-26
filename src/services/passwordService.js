/**
 * Inventory local passwords: AES-256-CBC reversible encryption (iv:cipher hex).
 * Never store plaintext in users.password_encrypted.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

function getKey() {
  const secret = process.env.ENCRYPTION_KEY || 'inventory-app-encryption-key-32chars!!';
  return crypto.scryptSync(secret, 'inventory-app-salt', 32);
}

function isAesEncrypted(value) {
  if (!value || !String(value).includes(':')) return false;
  const [ivHex, encrypted] = String(value).split(':');
  return /^[0-9a-f]{32}$/i.test(ivHex || '') && /^[0-9a-f]+$/i.test(encrypted || '');
}

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]?\$\d{2}\$.{53}$/.test(value);
}

function encryptPassword(plainText) {
  if (!plainText) throw new Error('Password is required');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(String(plainText), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decryptPassword(encryptedText) {
  if (!encryptedText || !isAesEncrypted(encryptedText)) {
    throw new Error('Invalid encrypted password format');
  }
  const [ivHex, encrypted] = String(encryptedText).split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Verify password. Supports AES (normal), accidental plaintext, and leftover bcrypt
 * (bcrypt matches are marked needsUpgrade → re-save as AES on login).
 */
function verifyPasswordDetailed(plainText, stored) {
  if (!stored) return { ok: false, needsUpgrade: false };
  const plain = String(plainText);
  const value = String(stored);

  if (isAesEncrypted(value)) {
    try {
      return { ok: decryptPassword(value) === plain, needsUpgrade: false };
    } catch {
      return { ok: false, needsUpgrade: false };
    }
  }

  if (isBcryptHash(value)) {
    try {
      const bcrypt = require('bcryptjs');
      const ok = bcrypt.compareSync(plain, value);
      return { ok, needsUpgrade: ok };
    } catch {
      return { ok: false, needsUpgrade: false };
    }
  }

  // Plaintext in DB — accept once, then upgrade to AES
  const ok = value === plain;
  return { ok, needsUpgrade: ok };
}

function verifyPassword(plainText, stored) {
  return verifyPasswordDetailed(plainText, stored).ok;
}

/**
 * Ensure every user row uses AES encryption.
 * - already AES → leave
 * - plaintext → encrypt
 * - bcrypt → skip (no plaintext; upgraded on next successful login)
 */
async function migratePasswordsToAes(conn) {
  const [rows] = await conn.query('SELECT id, password_encrypted FROM users');
  let upgraded = 0;
  for (const row of rows) {
    const stored = row.password_encrypted;
    if (!stored || isAesEncrypted(stored) || isBcryptHash(stored)) continue;
    await conn.query('UPDATE users SET password_encrypted = ? WHERE id = ?', [
      encryptPassword(String(stored)),
      row.id,
    ]);
    upgraded += 1;
  }
  return upgraded;
}

module.exports = {
  encryptPassword,
  decryptPassword,
  verifyPassword,
  verifyPasswordDetailed,
  isAesEncrypted,
  migratePasswordsToAes,
};
