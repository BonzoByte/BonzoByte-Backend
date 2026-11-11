import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import { validatePopularityView } from '../utils/popularity.js';

export function createPopularityRouter({ service, auth = protect, limits = {} }) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    const limiter = (max, extra = {}) => rateLimit({ windowMs: 60000, max, standardHeaders: true,
        legacyHeaders: false, message: { code: 'POPULARITY_RATE_LIMIT' }, ...extra });
    // IP limit before auth or any DB access; user limit also spans rotating IPs
    // on this process. Existing app-wide/beta limits still run first.
    router.use(limiter(limits.ip ?? 120));
    const memberLimit = limiter(limits.user ?? 60, { keyGenerator: req => String(req.user._id) });
    const handle = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) {
            const known = /^POPULARITY_/.test(error.code || '') && [400, 401, 404, 503].includes(error.status);
            res.status(known ? error.status : 503).json({ code: known ? error.code : 'POPULARITY_UNAVAILABLE' });
        }
    };
    const actor = req => ({ user: req.user._id, operation: req.accountOperation });
    router.get('/', handle(async (_req, res) => res.json(await service.rankings())));
    router.post('/views', (req, res, next) => {
        // Validate consent BEFORE protect claims a write lease on the account.
        try { validatePopularityView(req.body); next(); }
        catch (error) { res.status(error.status).json({ code: error.code }); }
    }, auth, memberLimit, handle(async (req, res) => {
        // Await persistence before finish releases the existing account lease.
        res.status(202).json(await service.view(actor(req), req.body));
    }));
    router.delete('/views', auth, memberLimit, handle(async (req, res) => {
        await service.withdraw(actor(req));
        res.status(204).end();
    }));
    return router;
}
