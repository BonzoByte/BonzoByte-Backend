import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { parseMatchLinkId } from '../utils/matchLinks.js';

export function createMatchLinksRouter({ service }) {
    const router = Router();
    router.use((_req, res, next) => {
        res.set('Cache-Control', 'private, no-store'); res.vary('Authorization'); next();
    });
    router.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
    const handle = kind => async (req, res) => {
        const controller = new AbortController();
        const closed = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', closed);
        try {
            const id = parseMatchLinkId(req.params.id);
            const result = await service[kind](id, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
            if (!res.destroyed) res.json(result);
        } catch (error) {
            if (res.destroyed) return;
            const known = ['MATCH_LINK_INVALID_ID', 'MATCH_LINK_NOT_FOUND'].includes(error.code);
            res.status(known ? error.status : 503).json({ code: known ? error.code : 'MATCH_LINK_UNAVAILABLE' });
        } finally { res.off('close', closed); }
    };
    router.get('/legacy/:id', handle('legacy'));
    router.get('/:id', handle('canonical'));
    return router;
}
