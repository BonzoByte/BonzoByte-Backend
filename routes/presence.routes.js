import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import { parsePresenceContexts } from '../utils/presence.js';
export function createPresenceRouter({ read, available = () => true, auth = protect, limits = {} }) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set({ 'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store' }); res.vary('Authorization'); next(); });
    router.use(rateLimit({ windowMs: 60000, max: limits.ip ?? 120, standardHeaders: true, legacyHeaders: false }));
    router.head('/', (_req, res) => res.set('Allow', 'GET').status(405).end());
    router.get('/', (req, res, next) => {
        try { req.presenceContexts = parsePresenceContexts(req.query); next(); }
        catch { res.status(400).json({ code: 'PRESENCE_INVALID_QUERY' }); }
    }, auth, rateLimit({ windowMs: 60000, max: limits.user ?? 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => String(req.user._id) }), async (req, res) => {
        if (!req.user?.isVerified) return res.status(403).json({ code: 'PRESENCE_AUTH_REQUIRED' });
        if (!available()) return res.status(503).json({ code: 'PRESENCE_UNAVAILABLE' });
        try { const result = await read(req.user, req.presenceContexts); if (!res.destroyed) res.json(result); }
        catch { if (!res.headersSent && !res.destroyed) res.status(503).json({ code: 'PRESENCE_UNAVAILABLE' }); }
    });
    return router;
}
