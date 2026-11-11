import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import { deletion, deletionAvailable, runAccountDeletion } from '../utils/accountDeletionRuntime.js';

export function createDeletionRouter({ service = deletion, available = deletionAvailable, auth = protect, run = runAccountDeletion } = {}) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    router.use(rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false }));
    const handle = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) { res.status(error.status || 503).json({ code: error.status ? error.code : 'DELETION_UNAVAILABLE' }); }
    };
    // Random possession receipt gives no email, identity, reason or financial details.
    router.post('/status', handle(async (req, res) => res.json(await service.status(req.body?.receipt))));
    router.use(auth);
    router.get('/config', (_req, res) => res.json({ available: available() }));
    router.post('/code', handle(async (req, res) => res.json(await service.requestCode(req.user._id, req.body?.language))));
    router.post('/confirm', handle(async (req, res) => {
        await service.confirm(req.user._id, req.body);
        res.status(202).json({ state: 'queued' });
        void run();
    }));
    return router;
}
export default createDeletionRouter();
