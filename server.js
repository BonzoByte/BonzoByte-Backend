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

import { env, corsAllowlist, betaEnabled } from './config/env.js';
import { createCorsOptions, forcePrivateHeaders, privateAccessLog } from './utils/accessPolicy.js';
import { authAccessLog, isAuthRequest } from './utils/oauthFlow.js';
import { DISCUSSION_JSON_LIMIT } from './utils/discussionText.js';
import { betaGate, initializeBeta } from './utils/betaRuntime.js';
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
import accountDeletionRoutes from './routes/accountDeletion.routes.js';
import { initializeAccountDeletion } from './utils/accountDeletionRuntime.js';
import archivesRoutes from './routes/archives.routes.js';
import referralsRoutes from './routes/referrals.routes.js';
import billingRoutes from './routes/billing.routes.js';
import { billingLabEnabled, initializeBillingLab } from './utils/billingLabRuntime.js';
import { billingWebhook, initializePlanBilling } from './utils/planBillingRuntime.js';
import { createPopularityRouter } from './routes/popularity.routes.js';
import { popularity, initializePopularity } from './utils/popularityRuntime.js';
import { createFavouritesRouter, favouritesPrivateResponse, favouritesJsonError } from './routes/favourites.routes.js';
import { favourites, initializeFavourites } from './utils/favouritesRuntime.js';
import { createDiscussionsRouter, discussionsHeaders, discussionsJsonError } from './routes/discussions.routes.js';
import { discussions, initializeDiscussions } from './utils/discussionRuntime.js';
import { createPrivateMessagesRouter, privateMessagesHeaders, privateMessagesJsonError } from './routes/privateMessages.routes.js';
import { privateMessages, initializePrivateMessages } from './utils/privateMessagesRuntime.js';
import { createNotificationsRouter, notificationHeaders, isNotificationRequest } from './routes/notifications.routes.js';
import { notifications, notificationDelivery, notificationsAvailable } from './utils/notificationRuntime.js';
import { createPresenceRouter } from './routes/presence.routes.js';
import { readPresence } from './utils/presenceRuntime.js';
import { createMatchLinksRouter } from './routes/matchLinks.routes.js';
import { matchLinks } from './utils/matchLinksRuntime.js';
import { createCompetitionRouter, competitionHeaders, competitionJsonError } from './routes/competition.routes.js';
import { competition, initializeCompetition } from './utils/competitionRuntime.js';

const ARCHIVES_ONLY = String(env.ARCHIVES_ONLY || '').toLowerCase() === 'true';

const app = express();
const recoveryPreview = Boolean(process.env.BONZOBYTE_RECOVERY_OVERLAY || process.env.BONZOBYTE_REVIEWED_ARCHIVES
    || process.env.BONZOBYTE_REVIEWED_LOCAL_RELEASE || process.env.BONZOBYTE_REVIEWED_REPORTS);
if (recoveryPreview) {
    if (env.NODE_ENV !== 'development' || env.APP_STAGE !== 'development') throw new Error('Recovery backend requires local development.');
    app.use((req, res, next) => {
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) {
            return res.status(403).json({ message: 'Local recovery preview only.' });
        }
        res.set('X-BonzoByte-Preview', process.env.BONZOBYTE_REVIEWED_ARCHIVES ? 'verified-completed-local-set' : 'paused-archive-recovery');
        next();
    });
}
app.set('trust proxy', env.TRUST_PROXY_HOPS || false);
if (betaEnabled) app.use(forcePrivateHeaders);
// Even CORS preflight/rejection responses on this private API must not be cached.
app.use('/api/favourites', favouritesPrivateResponse);
app.use('/api/discussions', discussionsHeaders);
app.use('/api/private-messages', privateMessagesHeaders);
app.use('/api/notifications', notificationHeaders);
app.use('/api/competition', competitionHeaders);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ----------------------------- C O R S ------------------------------ */
const corsOptions = createCorsOptions(corsAllowlist);

app.use(cors(corsOptions));

/* --------------------------- Core middleware ------------------------ */
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
    })
);
app.use(compression({ filter: (req, res) => !isNotificationRequest(req) && compression.filter(req, res) }));
if (betaEnabled) app.use(morgan(privateAccessLog));
else {
    app.use(morgan('dev', { skip: req => isAuthRequest(req) || isNotificationRequest(req) }));
    app.use(morgan(authAccessLog, { skip: req => !isAuthRequest(req) }));
}
// Keep the original JSON payload for PayPal's signature verification, before json().
app.post('/api/billing/paypal/webhook', rateLimit({ windowMs: 60_000, max: 100 }),
    express.raw({ type: 'application/json', limit: '256kb' }), billingWebhook);
// Apply privacy and bounded JSON parsing before global parsers/limits/gates,
// including malformed/oversized favourites requests and their error responses.
app.use('/api/favourites', json({ limit: '8kb' }), favouritesJsonError);
app.use('/api/discussions', json({ limit: DISCUSSION_JSON_LIMIT }), discussionsJsonError);
app.use('/api/private-messages', json({ limit: DISCUSSION_JSON_LIMIT }), privateMessagesJsonError);
app.use('/api/competition', json({ limit: '4kb' }), competitionJsonError);
app.use(json({ limit: '1mb' }));
app.use(urlencoded({ extended: true }));
if (billingLabEnabled) {
    app.use((req, res, next) => {
        res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
        // No external email, OAuth callbacks, avatars or unrelated writes from the lab.
        const authAllowed = /^\/api\/auth\/(register|login|logout|me|nickname-exists\/[^/]+)$/.test(req.path);
        if ((req.path.startsWith('/api/auth/') && !authAllowed)
            || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !authAllowed && !req.path.startsWith('/api/billing/')))
            return res.status(404).json({ code: 'NOT_AVAILABLE_IN_BILLING_LAB' });
        next();
    });
}

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
// Count untrusted beta-session probes too, before they can query MongoDB.
if (betaGate) app.use(betaGate);

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
if (!ARCHIVES_ONLY && !billingLabEnabled && !betaEnabled) {
    await import('./config/passport.js');
} else {
    console.log('[AUTH] OAuth strategies disabled in this isolated mode.');
}

/* ------------------------------ Routes ----------------------------- */

// A small root response distinguishes a healthy service from a missing route.
app.get('/', (_req, res) => res.json({ ok: true, service: 'bonzobyte-backend' }));

// ✅ health
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/robots.txt', (_req, res) => res.set('X-Robots-Tag', 'noindex, nofollow').type('text/plain').send('User-agent: *\nAllow: /\n'));

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

// Mount local player photos only when the configured directory exists.
const photosDirRaw = process.env.PLAYERS_PHOTO_DIR;
const photosDirTrimmed = typeof photosDirRaw === 'string' ? photosDirRaw.trim() : '';
if (photosDirTrimmed) {
    const PHOTOS_DIR = path.resolve(photosDirTrimmed);

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

// Database and authentication routes are disabled in archives-only mode.
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
    app.use('/api/users/me/deletion', accountDeletionRoutes);
    app.use('/api/referrals', referralsRoutes);
    app.use('/api/billing', billingRoutes);
    app.use('/api/popularity', createPopularityRouter({ service: popularity }));
    app.use('/api/favourites', createFavouritesRouter({ service: favourites }));
    if (!billingLabEnabled) app.use('/api/discussions', createDiscussionsRouter({ service: discussions, notify: notificationDelivery }));
    if (!billingLabEnabled) app.use('/api/private-messages', createPrivateMessagesRouter({ service: privateMessages, notify: notificationDelivery }));
    if (!billingLabEnabled) app.use('/api/notifications', createNotificationsRouter({ hub: notifications, available: notificationsAvailable }));
    if (!billingLabEnabled) app.use('/api/presence', createPresenceRouter({ read: readPresence, available: notificationsAvailable }));
    if (!billingLabEnabled) app.use('/api/match-links', createMatchLinksRouter({ service: matchLinks }));
    if (!billingLabEnabled) app.use('/api/competition', createCompetitionRouter({ service: competition }));
} else {
    console.log('🟢 ARCHIVES_ONLY: mounting only /api/archives (no DB routes).');
}

/* --------------------------- Error handlers ------------------------- */
app.use((err, req, res, next) => {
    if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ message: 'File too large (max 5MB).' });
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

// Include the requested path in 404 responses to simplify diagnostics.
app.use((req, res) => res.status(404).json({ message: 'Ruta nije pronađena', path: req.originalUrl }));

/* --------------------------- Start server --------------------------- */
if (!ARCHIVES_ONLY) {
    await connectDB();
    await initializeBeta();
    await initializeBillingLab();
    await initializePlanBilling();
    await initializeDiscussions();
    await initializePrivateMessages();
    await initializeAccountDeletion();
    await initializePopularity();
    await initializeFavourites();
    await initializeCompetition();
} else {
    console.log('🔕 ARCHIVES_ONLY mode: skipping DB connect.');
}

console.log(`[archives] source=${env.ARCHIVES_SOURCE}`);
const failStartup = (error) => {
    const code = error?.code || 'LISTEN_FAILED';
    const reason = code === 'EADDRINUSE'
        ? `Port ${env.PORT} is already in use. Stop the existing backend before starting another instance.`
        : `Cannot listen on port ${env.PORT} (${code}).`;
    console.error(`[STARTUP] ${reason} Backend did not start (PID ${process.pid}).`);
    // This process may already have an open Mongo connection. Exit immediately
    // rather than leaving a second, non-listening backend running in the background.
    process.exit(1);
};

try {
    // Express 5 also invokes app.listen's callback on errors. Listen for the
    // actual listening event instead, so a failed bind never prints success.
    const httpServer = (billingLabEnabled || recoveryPreview) ? app.listen(env.PORT, '127.0.0.1') : app.listen(env.PORT);
    httpServer.once('error', failStartup);
    httpServer.once('close', () => notifications.close());
    httpServer.once('listening', () => {
        const port = httpServer.address()?.port ?? env.PORT;
        console.log(`Server running on :${port} (PID ${process.pid}) 🚀`);
    });
} catch (error) {
    failStartup(error);
}

process.on('unhandledRejection', (e) => {
    console.error(e);
    process.exit(1);
});
process.on('uncaughtException', (e) => {
    console.error(e);
    process.exit(1);
});
