import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import { parseFavouriteId, validateFavouriteBody, validateFavouriteIds } from '../utils/favourites.js';

export const favouritesPrivateResponse = (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    next();
};
export function favouritesJsonError(error, _req, res, next) {
    if (['entity.parse.failed', 'entity.too.large'].includes(error.type))
        return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ code: 'FAVOURITES_INVALID_BODY' });
    next(error);
}
export function createFavouritesRouter({ service, auth = protect, limits = {}, resolveTimeoutMs = 27000 }) {
    const router = express.Router();
    router.use(favouritesPrivateResponse);
    const limiter = (max, extra = {}) => rateLimit({ windowMs: 60000, max, standardHeaders: true,
        legacyHeaders: false, message: { code: 'FAVOURITES_RATE_LIMIT' }, ...extra });
    router.use(limiter(limits.ip ?? 240));
    router.use(express.json({ limit: '8kb' }), favouritesJsonError);
    const memberLimit = limiter(limits.user ?? 120, { keyGenerator: req => String(req.user._id) });
    // A 1,000-item list needs 20 batches; allow full loads, a refresh and retries.
    const resolveLimit = limiter(limits.resolve ?? 60, { keyGenerator: req => String(req.user._id) });
    const handle = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) {
            if (res.headersSent) return;
            const known = /^FAVOURITES_/.test(error.code || '') && [400, 401, 404, 409, 503].includes(error.status);
            res.status(known ? error.status : 503).json({ code: known ? error.code : 'FAVOURITES_UNAVAILABLE' });
        }
    };
    const validate = fn => (req, res, next) => {
        try {
            if (Object.keys(req.query).length) return res.status(400).json({ code: 'FAVOURITES_INVALID_QUERY' });
            fn(req); next();
        } catch (error) { res.status(400).json({ code: error.code || 'FAVOURITES_INVALID_BODY' }); }
    };
    const actor = req => ({ user: req.user._id, tokenVersion: req.user.tokenVersion ?? 0,
        operation: req.accountOperation, ...(req.favouritesSignal ? { signal: req.favouritesSignal } : {}) });
    const resolveDeadline = (req, res, next) => {
        const controller = new AbortController(); req.favouritesSignal = controller.signal;
        const timer = setTimeout(() => {
            controller.abort();
            if (!res.headersSent) res.status(503).json({ code: 'FAVOURITES_UNAVAILABLE' });
        }, resolveTimeoutMs);
        timer.unref();
        res.once('finish', () => clearTimeout(timer));
        res.once('close', () => { clearTimeout(timer); controller.abort(); });
        next();
    };
    router.get('/matches', validate(() => {}), auth, memberLimit,
        handle(async (req, res) => res.json(await service.list(actor(req)))));
    router.post('/matches/resolve', validate(req => validateFavouriteIds(req.body)), resolveDeadline, auth,
        (req, _res, next) => { if (!req.favouritesSignal.aborted) next(); }, memberLimit, resolveLimit,
        handle(async (req, res) => {
            const response = await service.resolve(actor(req), req.body);
            if (!res.headersSent) res.json(response);
        }));
    router.put('/matches/:id', validate(req => {
        req.matchTPId = parseFavouriteId(req.params.id); validateFavouriteBody(req.body);
    }), auth, memberLimit, handle(async (req, res) => res.json(await service.save(actor(req), req.matchTPId))));
    router.delete('/matches/:id', validate(req => {
        req.matchTPId = parseFavouriteId(req.params.id);
        if (req.body !== undefined) validateFavouriteBody(req.body);
    }), auth, memberLimit, handle(async (req, res) => res.json(await service.remove(actor(req), req.matchTPId))));
    return router;
}
