import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import { competitionId, competitionMonth, competitionError } from '../utils/competitionPolicy.js';

export function competitionHeaders(_req, res, next) {
    res.set('Cache-Control', 'private, no-store'); res.vary('Authorization'); next();
}
export function competitionJsonError(error, _req, res, next) {
    if (['entity.parse.failed', 'entity.too.large'].includes(error.type))
        return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ code: 'COMPETITION_INVALID_BODY' });
    next(error);
}
export function createCompetitionRouter({ service, auth = protect, limits = {}, now = () => new Date() }) {
    const router = express.Router();
    router.use(competitionHeaders);
    router.use(rateLimit({ windowMs: 60000, max: limits.ip ?? 120, standardHeaders: true, legacyHeaders: false,
        message: { code: 'COMPETITION_RATE_LIMIT' } }));
    router.use(express.json({ limit: '4kb' }), competitionJsonError);
    const handle = fn => async (req, res) => {
        try { await fn(req, res); } catch (error) {
            if (res.headersSent) return;
            const known = /^COMPETITION_/.test(error.code || '') && [400, 401, 403, 404, 409, 503].includes(error.status);
            res.status(known ? error.status : 503).json({ code: known ? error.code : 'COMPETITION_UNAVAILABLE' });
        }
    };
    const actor = req => ({ user: req.user._id, tokenVersion: req.user.tokenVersion ?? 0, operation: req.accountOperation });
    const query = (req, allowed = []) => {
        if (Object.keys(req.query).some(key => !allowed.includes(key))
            || (req.query.month !== undefined && typeof req.query.month !== 'string'))
            throw competitionError('COMPETITION_INVALID_QUERY', 400);
    };
    const demo = req => {
        if (req.query.demo === undefined) return false;
        if (req.query.demo !== '1') throw competitionError('COMPETITION_INVALID_QUERY', 400);
        return true;
    };
    const verified = (req, res, next) => req.user.isVerified === true ? next()
        : res.status(403).json({ code: 'COMPETITION_VERIFICATION_REQUIRED' });
    const member = rateLimit({ windowMs: 60000, max: limits.user ?? 60, standardHeaders: true, legacyHeaders: false,
        keyGenerator: req => String(req.user._id), message: { code: 'COMPETITION_RATE_LIMIT' } });
    router.get('/rules', handle(async (req, res) => { query(req); res.json(await service.rules()); }));
    router.get('/leaderboard', handle(async (req, res) => {
        query(req, ['month', 'demo']); res.json(await service.leaderboard(competitionMonth(req.query.month, now()), demo(req)));
    }));
    router.get('/me', auth, member, handle(async (req, res) => {
        query(req, ['month', 'demo']); res.json(await service.me(actor(req), competitionMonth(req.query.month, now()), demo(req)));
    }));
    router.get('/profiles/:id/picks', handle(async (req, res) => {
        query(req, ['month', 'demo']);
        res.json(await service.publicPicks(req.params.id, competitionMonth(req.query.month, now()), demo(req)));
    }));
    router.get('/matches/:id', auth, member, verified, handle(async (req, res) => {
        query(req); res.json(await service.match(actor(req), competitionId(req.params.id)));
    }));
    router.post('/matches/:id', auth, member, verified, handle(async (req, res) => {
        query(req); res.json(await service.submit(actor(req), competitionId(req.params.id), req.body));
    }));
    return router;
}
