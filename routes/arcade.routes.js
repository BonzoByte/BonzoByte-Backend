import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
export const arcadeHeaders = (_req, res, next) => { res.set('Cache-Control','private, no-store'); res.vary('Authorization'); next(); };
export function arcadeJsonError(error, _req, res, next) {
    if (['entity.too.large','entity.parse.failed'].includes(error.type)) return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ code: 'ARCADE_INVALID_BODY' });
    next(error);
}
export function createArcadeRouter({ service, auth = protect }) {
    const router = express.Router(); router.use(arcadeHeaders);
    router.use(rateLimit({ windowMs: 60000, max: 90, standardHeaders: true, legacyHeaders: false, message: { code: 'ARCADE_RATE_LIMIT' } }));
    router.use(express.json({ limit: '900kb' }), arcadeJsonError);
    const actor = req => ({ user: req.user._id, tokenVersion: req.user.tokenVersion ?? 0, operation: req.accountOperation });
    const handle = fn => async (req, res) => { try { await fn(req,res); } catch (e) {
        if (res.headersSent) return;
        const known = /^ARCADE_/.test(e.code || '') && [400,401,403,404,409,503].includes(e.status);
        res.status(known ? e.status : 503).json({ code: known ? e.code : 'ARCADE_UNAVAILABLE' });
    } };
    const verified = (req,res,next) => req.user.isVerified === true ? next() : res.status(403).json({ code: 'ARCADE_VERIFICATION_REQUIRED' });
    const writeLimit = rateLimit({ windowMs:60000,max:20,keyGenerator:req=>String(req.user._id),standardHeaders:true,legacyHeaders:false,message:{code:'ARCADE_RATE_LIMIT'} });
    router.get('/opponents', handle(async (req,res) => {
        if (Object.keys(req.query).some(k => k !== 'q') || (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 80))) return res.status(400).json({ code:'ARCADE_INVALID_QUERY' });
        res.json(await service.opponents(req.query.q || ''));
    }));
    router.get('/leaderboard', handle(async (req,res) => {
        const month = req.query.month ?? new Date().toISOString().slice(0,7);
        if (Object.keys(req.query).some(k => k !== 'month') || typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ code:'ARCADE_INVALID_QUERY' });
        res.json(await service.leaderboard(month));
    }));
    router.get('/me', auth, handle(async (req,res) => res.json(await service.me(actor(req)))));
    router.post('/sessions', auth, verified, writeLimit, handle(async (req,res) => res.json(await service.start(actor(req),req.body))));
    router.post('/sessions/:id/finish', auth, verified, writeLimit, handle(async (req,res) => res.json(await service.finish(actor(req),req.params.id,req.body))));
    return router;
}
