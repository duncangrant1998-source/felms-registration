const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const PHOTO_DIR = path.join(UPLOAD_DIR, "photos");
const DOC_DIR = path.join(UPLOAD_DIR, "documents");

for (const dir of [UPLOAD_DIR, PHOTO_DIR, DOC_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function randomName(originalName) {
  const ext = path.extname(originalName || "").slice(0, 10);
  return crypto.randomBytes(12).toString("hex") + ext;
}

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_DIR),
    filename: (req, file, cb) => cb(null, randomName(file.originalname))
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) return cb(null, true);
    cb(new Error("Headshot must be an image file."));
  }
});

const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOC_DIR),
    filename: (req, file, cb) => cb(null, randomName(file.originalname))
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

module.exports = { UPLOAD_DIR, PHOTO_DIR, DOC_DIR, photoUpload, documentUpload };
