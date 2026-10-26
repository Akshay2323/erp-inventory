const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

/** KYC documents are private — stored outside /uploads and streamed only through the API. */
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage', 'party-documents');
const ALLOWED_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

function uploaderFor(moduleKey) {
  const dir = path.join(STORAGE_ROOT, moduleKey);
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ALLOWED_TYPES[file.mimetype]}`);
      },
    }),
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
      const err = new Error('file must be a PDF, PNG, JPG or WEBP');
      err.status = 400;
      cb(err);
    },
  });
}

/** multipart/form-data with optional "file"; sets req.documentFile = columns for the documents table. */
function uploadDocument(moduleKey) {
  const upload = uploaderFor(moduleKey);
  return (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? `file must be smaller than ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB`
          : err.message;
        return res.status(err.status || 400).json({ error: message });
      }
      if (req.file) {
        req.documentFile = {
          file_path: path.relative(path.join(__dirname, '..', '..'), req.file.path).split(path.sep).join('/'),
          original_name: req.file.originalname.slice(0, 255),
          mime_type: req.file.mimetype,
          file_size: req.file.size,
        };
      }
      next();
    });
  };
}

module.exports = { uploadDocument };
