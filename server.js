// server.js
import cors from 'cors';
import 'dotenv/config';
import express, { json, urlencoded } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import passport from 'passport';
import { fileURLToPath } from 'url';
import { MulterError } from 'multer';
import fs from 'fs';

import { env, corsAllowlist } from './config/env.js';
import connectDB from './config/db.js';

import countryRoutes from './routes/country.routes.js';
import playsRoutes from './routes/plays.routes.js';
import surfaceRoutes from './routes/surface.routes.js';
import tournamentTypeRoutes from './routes/tournamentType.routes.js';
import tournamentLevelRoutes from './routes/tournamentLevel.routes.js';
import tournamentEventRoutes from './routes/tournamentEvent.routes.js';
import playerRoutes from './routes/player.routes.js';
import matchRoutes from './routes/match.routes.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import archivesRoutes from './routes/archives.routes.js';

const ARCHIVES_ONLY = String(process.env.ARCHIVES_ONLY || '').toLowerCase() === 'true';

const photosDirRaw = process.env.PLAYERS_PHOTO_DIR;
const PHOTOS_DIR = path.resolve(String(photosDirRaw || '').trim());

console.log('[PLAYERS_PHOTO_DIR raw]   =', JSON.stringify(photosDirRaw));
console.log('[PLAYERS_PHOTO_DIR abs]   =', PHOTOS_DIR);
console.log('[PLAYERS_PHOTO_DIR exists]=', fs.existsSync(PHOTOS_DIR));

if (fs.existsSync(PHOTOS_DIR)) {
    const sample = fs.readdirSync(PHOTOS_DIR).slice(0, 20);
    console.log('[PLAYERS_PHOTO_DIR files]=', sample);
}

const app = express();
app.set('trust proxy', 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ----------------------------- C O R S ------------------------------ */
const isVercelPreview = (origin) =>
    /^https:\/\/bonzo-byte-frontend.*\.vercel\.app$/.test(origin);

const corsOptions = {
    origin(origin, cb) {
        if (!origin) return cb(null, true); // postman/server-to-server

        const isAllowed =
            corsAllowlist.includes(origin) ||
            origin.endsWith('.vercel.app'); // ✅ dopušta sve Vercel deploye

        cb(isAllowed ? null : new Error('Not allowed by CORS'), isAllowed);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

/* --------------------------- Core middleware ------------------------ */
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(morgan('dev'));
app.use(json({ limit: '1mb' }));
app.use(urlencoded({ extended: true }));

/* --------------------------- Rate limiting -------------------------- */
const skipPreflight = (req) => req.method === 'OPTIONS';

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipPreflight,
});
app.use(globalLimiter);

const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 50,
    message: { message: 'Too many auth requests, try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipPreflight,
});

/* ----------------------------- Passport ----------------------------- */
app.use(passport.initialize());
// Dinamički učitaj strategije samo ako nisu “archives-only”
if (!ARCHIVES_ONLY) {
    await import('./config/passport.js');
} else {
    console.log('🔕 ARCHIVES_ONLY mode: skipping passport strategies.');
}

/* ------------------------------ Statics ----------------------------- */

// U oba moda: archives rute su aktivne
app.use('/api/archives', archivesRoutes);

// Player photos (local static)  ✅ URL: /static/players/photo/<file>
app.use('/static/players/photo', express.static(PHOTOS_DIR, {
    fallthrough: false,
    setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
    }
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));

/* -------------------------------- Routes ---------------------------- */
if (!ARCHIVES_ONLY) {
    app.use('/api/countries', countryRoutes);
    app.use('/api/plays', playsRoutes);
    app.use('/api/surfaces', surfaceRoutes);
    app.use('/api/tournamentTypes', tournamentTypeRoutes);
    app.use('/api/tournamentLevels', tournamentLevelRoutes);
    app.use('/api/tournamentEvents', tournamentEventRoutes);
    app.use('/api/players', playerRoutes);
    app.use('/api/matches', matchRoutes);
    app.use('/api/auth', authLimiter, authRoutes);
    app.use('/api/users', userRoutes);
} else {
    console.log('🟢 ARCHIVES_ONLY: mounting only /api/archives (no DB routes).');
}

/* --------------------------- Error handlers ------------------------- */
app.use((err, req, res, next) => {
    if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ message: 'File too large (max 2MB).' });
        }
        return res.status(400).json({ message: `Upload error: ${err.code}` });
    }
    if (err && err.message === 'Not allowed by CORS') {
        return res.status(403).json({ message: err.message });
    }
    if (err && err.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({ message: 'Invalid file type. Allowed: JPG, PNG, WebP.' });
    }
    next(err);
});

// health & 404
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.use((req, res) => res.status(404).json({ message: 'Ruta nije pronađena' }));

/* --------------------------- Start server --------------------------- */
if (!ARCHIVES_ONLY) {
    await connectDB();
} else {
    console.log('🔕 ARCHIVES_ONLY mode: skipping DB connect.');
}

console.log(`[archives] source=${env.ARCHIVES_SOURCE}`);
app.listen(env.PORT, () => console.log(`Server running on :${env.PORT} 🚀`));

process.on('unhandledRejection', e => { console.error(e); process.exit(1); });
process.on('uncaughtException', e => { console.error(e); process.exit(1); });