import express from 'express';
import rateLimit from 'express-rate-limit';
import { BETA_COOKIE, BETA_SESSION_MS, betaCookieToken } from './betaAccess.js';
import { betaPage } from './betaPage.js';
import { privateHeaders } from './accessPolicy.js';
export function createBetaGate({ access, publicOrigin }) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set(privateHeaders); next(); });
    router.use((req, res, next) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== publicOrigin)
            return res.status(403).json({ code: 'BETA_ORIGIN_DENIED' });
        next();
    });
    const publicLimiter = rateLimit({ windowMs: 15 * 60000, max: 40, standardHeaders: true, legacyHeaders: false });
    router.get('/beta', async (req, res) => {
        try { res.type('html').send(betaPage({ authenticated: !!await access.session(betaCookieToken(req.headers.cookie)) })); }
        catch { res.status(503).type('html').send(betaPage({ message: 'Private beta is temporarily unavailable. Please try again later.' })); }
    });
    router.post('/beta/request', publicLimiter, async (req, res) => {
        try { const challenge = await access.request(req.body?.email); res.type('html').send(betaPage({ challenge })); }
        catch { res.status(503).type('html').send(betaPage({ message: 'Please try again later.' })); }
    });
    router.post('/beta/verify', publicLimiter, async (req, res) => {
        try {
            const token = await access.verify(req.body?.challenge, req.body?.code);
            res.cookie(BETA_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: BETA_SESSION_MS });
            res.redirect(303, '/');
        } catch (error) {
            const invalid = error?.code === 'BETA_VERIFICATION_FAILED';
            const challenge = /^[a-f0-9]{64}$/.test(req.body?.challenge || '') ? req.body.challenge : '';
            res.status(invalid ? 400 : 503).type('html').send(betaPage({ challenge, message: invalid
                ? 'The code is incorrect, expired or already used. Try again or request a new code.'
                : 'Private beta is temporarily unavailable. Please try again later.' }));
        }
    });
    router.post('/beta/logout', async (req, res) => {
        try {
            await access.logout(betaCookieToken(req.headers.cookie));
            res.clearCookie(BETA_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
            res.redirect(303, '/beta');
        } catch { res.status(503).json({ code: 'BETA_UNAVAILABLE' }); }
    });
    router.use(async (req, res, next) => {
        const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
        // Receipt status remains readable after the deleted account's beta
        // session is revoked. It returns only a state, requires a random receipt
        // in the POST body and has its own rate limit; no account/API bypass.
        if (req.method === 'POST' && req.path === '/api/users/me/deletion/status') return next();
        // No auth, archive or upload exception; only the health probe and robots.
        if (['GET', 'HEAD'].includes(req.method) && ['/api/health', '/robots.txt'].includes(req.path)) return next();
        try {
            const session = await access.session(betaCookieToken(req.headers.cookie));
            if (!session) return res.status(401).json({ code: 'BETA_ACCESS_REQUIRED' });
            req.betaTester = session;
            if (req.path === '/beta/session' && req.method === 'GET') return res.json({ betaAccess: true });
            if (/^\/api\/auth\/(google|facebook|dev|debug)(\/|$)/i.test(req.path))
                return res.status(404).json({ code: 'NOT_AVAILABLE_IN_BETA' });
            // Approved testers cannot use app emails/referrals to expand the list.
            if (req.body?.email !== undefined && (path.startsWith('/api/auth/') || path === '/api/referrals/invite')
                && !access.allowed(req.body.email)) return res.status(403).json({ code: 'BETA_EMAIL_NOT_ALLOWED' });
            next();
        } catch { res.status(503).json({ code: 'BETA_UNAVAILABLE' }); }
    });
    return router;
}
