import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';

export const isNotificationRequest = req => /^\/api\/notifications(?:\/|$)/.test(req.originalUrl?.split('?')[0] ?? req.path ?? '');
export const notificationHeaders = (_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store, no-transform', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' });
    res.vary('Authorization'); next();
};
export function createNotificationsRouter({ hub, auth = protect, available = () => true, limits = {} }) {
    const router = express.Router(); router.use(notificationHeaders);
    router.use(rateLimit({ windowMs: 60000, max: limits.ip ?? 120, standardHeaders: true, legacyHeaders: false, message: { code: 'NOTIFICATIONS_RATE_LIMIT' } }));
    router.head('/stream', (_req, res) => res.set('Allow', 'GET').status(405).end());
    router.get('/stream', (req, res, next) => {
        if (Object.keys(req.query).length) return res.status(400).json({ code: 'NOTIFICATIONS_INVALID_QUERY' });
        if (!available()) return res.set('Retry-After', '20').status(503).json({ code: 'NOTIFICATIONS_UNAVAILABLE' });
        req.isNotificationStream = true; next();
    }, auth, rateLimit({ windowMs: 60000, max: limits.user ?? 30, standardHeaders: true, legacyHeaders: false,
        keyGenerator: req => String(req.user._id), message: { code: 'NOTIFICATIONS_RATE_LIMIT' } }), (req, res) => {
        if (!req.user?.isVerified) return res.status(403).json({ code: 'NOTIFICATIONS_VERIFICATION_REQUIRED' });
        try { hub.attach(req, res, { userId: String(req.user._id), tokenVersion: req.user.tokenVersion ?? 0, expiresAt: req.authExpiresAt }); }
        catch (error) {
            if (res.headersSent || res.destroyed) return;
            const status = [401, 429].includes(error.status) ? error.status : 503;
            if (status !== 401) res.set('Retry-After', '20');
            res.status(status).json({ code: status === 401 ? 'NOTIFICATIONS_AUTH_REQUIRED' : status === 429 ? 'NOTIFICATIONS_CAPACITY' : 'NOTIFICATIONS_UNAVAILABLE' });
        }
    });
    return router;
}
