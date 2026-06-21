import multer from 'multer';
import path from 'path';
import fs from 'fs';

const ALLOWED_IMAGE_TYPES = new Map([
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
]);

const tmpDir = path.resolve('.tmp/avatar-uploads');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
    destination(req, file, cb) {
        cb(null, tmpDir);
    },
    filename(req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, `avatar-${uniqueSuffix}${ext}`);
    },
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const ok = ALLOWED_IMAGE_TYPES.get(ext) === file.mimetype;
    cb(ok ? null : new Error('INVALID_FILE_TYPE'), ok);
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

export default upload;
