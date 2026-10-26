const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

/** Product images & documents — private storage, streamed only through the API. */
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'product-media');
const ALLOWED_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const MAX_BYTES = 10 * 1024 * 1024;

fs.mkdirSync(STORAGE_ROOT, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: STORAGE_ROOT,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ALLOWED_TYPES[file.mimetype]}`);
    },
  }),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    const err = new Error('file must be a PDF, PNG, JPG or WEBP');
    err.status = 400;
    cb(err);
  },
});

/** multipart/form-data with field "file"; sets req.productFile for product_media columns. */
function uploadProductMedia(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `file must be smaller than ${MAX_BYTES / (1024 * 1024)} MB`
        : err.message;
      return res.status(err.status || 400).json({ error: message });
    }
    if (req.file) {
      req.productFile = {
        file_path: path.relative(path.join(__dirname, '..', '..'), req.file.path).split(path.sep).join('/'),
        original_name: req.file.originalname.slice(0, 255),
        mime_type: req.file.mimetype,
        file_size: req.file.size,
      };
    }
    next();
  });
}

module.exports = { uploadProductMedia };
