const fs = require('fs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  let s = String(value).trim();
  // Accept ISO datetimes from frontends (e.g. 2026-10-01T00:00:00.000Z)
  if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(s)) s = s.slice(0, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw httpError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  }
  return s;
}

function cleanText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function isTruthy(value) {
  return [true, 1, 'true', '1', 'yes', 'on'].includes(value);
}

/** Checkbox / boolean from JSON or multipart. undefined = not sent; null/'' = not sent. */
function parseBool(value, field = 'value') {
  if (value === undefined || value === null || value === '') return undefined;
  if (isTruthy(value)) return true;
  if ([false, 0, 'false', '0', 'no', 'off'].includes(value)) return false;
  throw httpError(400, `${field} must be true or false`);
}

function actorLabel(user) {
  return user?.email || user?.username || user?.name || null;
}

function removeUploadedFile(file) {
  if (file?.path) fs.promises.unlink(file.path).catch(() => {});
}

function sendError(res, err) {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
}

module.exports = {
  EMAIL_RE,
  httpError,
  today,
  addDays,
  parseDate,
  cleanText,
  isTruthy,
  parseBool,
  actorLabel,
  removeUploadedFile,
  sendError,
};
