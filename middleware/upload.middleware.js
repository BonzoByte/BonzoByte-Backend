import multer from 'multer';
import path from 'path';
import fs from 'fs';

const tmpDir = path.resolve('uploads/tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
    destination(req, file, cb) {
        cb(null, tmpDir); // privremeno u /uploads/tmp
    },
    filename(req, file, cb) {
        // random ime; ionako ćemo ga preraditi u kontroleru
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    },
});

const fileFilter = (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('INVALID_FILE_TYPE'), ok);
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

export default upload;
