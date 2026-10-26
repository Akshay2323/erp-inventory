const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { LOGO_DISK_DIR } = require('../services/companyService');

const ALLOWED_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

fs.mkdirSync(LOGO_DISK_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: LOGO_DISK_DIR,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED_TYPES[file.mimetype]}`);
    },
  }),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    const err = new Error('logo must be a PNG, JPG or WEBP image');
    err.status = 400;
    cb(err);
  },
});

/** Accepts multipart/form-data with optional "logo" file; JSON bodies pass through untouched. */
function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `logo must be smaller than ${MAX_LOGO_BYTES / (1024 * 1024)} MB`
      : err.message;
    res.status(err.status || 400).json({ error: message });
  });
}

module.exports = { uploadLogo };
