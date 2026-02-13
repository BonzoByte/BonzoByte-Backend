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

const ARCHIVES_ONLY = String(env.ARCHIVES_ONLY || '').toLowerCase() === 'true';

const app = express();
app.set('trust proxy', 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ----------------------------- C O R S ------------------------------ */
const corsOptions = {
    origin(origin, cb) {
        if (!origin) return cb(null, true); // Postman/server-to-server

        const isAllowed =
            corsAllowlist.includes(origin) ||
            origin.endsWith('.vercel.app'); // dopušta sve Vercel deploye

        cb(isAllowed ? null : new Error('Not allowed by CORS'), isAllowed);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

/* --------------------------- Core middleware ------------------------ */
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
    })
);
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
if (!ARCHIVES_ONLY) {
    await import('./config/passport.js');
} else {
    console.log('🔕 ARCHIVES_ONLY mode: skipping passport strategies.');
}

/* ------------------------------ Routes ----------------------------- */

// ✅ root (da ne zbunjuje "Ruta nije pronađena")
app.get('/', (_req, res) => res.json({ ok: true, service: 'bonzobyte-backend' }));

// ✅ health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ✅ archives su aktivne u oba moda
app.use('/api/archives', archivesRoutes);

// ✅ uploads (avatar)
app.use(
    '/uploads',
    express.static(path.join(__dirname, 'uploads'), {
        setHeaders: (res) => {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
    })
);

// ✅ player photos (lokalno) — mount samo ako postoji
const photosDirRaw = process.env.PLAYERS_PHOTO_DIR;
const photosDirTrimmed = typeof photosDirRaw === 'string' ? photosDirRaw.trim() : '';
if (photosDirTrimmed) {
    const PHOTOS_DIR = path.resolve(photosDirTrimmed);

    console.log('[PLAYERS_PHOTO_DIR raw]   =', JSON.stringify(photosDirRaw));
    console.log('[PLAYERS_PHOTO_DIR abs]   =', PHOTOS_DIR);
    console.log('[PLAYERS_PHOTO_DIR exists]=', fs.existsSync(PHOTOS_DIR));

    if (fs.existsSync(PHOTOS_DIR)) {
        app.use(
            '/static/players/photo',
            express.static(PHOTOS_DIR, {
                fallthrough: false,
                setHeaders: (res) => {
                    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
                    res.setHeader('Cache-Control', 'public, max-age=86400');
                },
            })
        );
    } else {
        console.log('⚠️ PLAYERS_PHOTO_DIR is set but folder does not exist. Skipping static mount.');
    }
} else {
    console.log('ℹ️ PLAYERS_PHOTO_DIR not set. Skipping photos static mount.');
}

// ✅ DB + auth rute samo ako nije archives-only
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

// ✅ 404 (vrati i path da odmah znamo što je user zvao)
app.use((req, res) => res.status(404).json({ message: 'Ruta nije pronađena', path: req.originalUrl }));

/* --------------------------- Start server --------------------------- */
if (!ARCHIVES_ONLY) {
    await connectDB();
} else {
    console.log('🔕 ARCHIVES_ONLY mode: skipping DB connect.');
}

console.log(`[archives] source=${env.ARCHIVES_SOURCE}`);
app.listen(env.PORT, () => console.log(`Server running on :${env.PORT} 🚀`));

process.on('unhandledRejection', (e) => {
    console.error(e);
    process.exit(1);
});
process.on('uncaughtException', (e) => {
    console.error(e);
    process.exit(1);
});