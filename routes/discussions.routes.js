import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import User from '../models/user.model.js';
import { beginAccountOperation } from '../utils/accountOperation.js';
import { DISCUSSION_JSON_LIMIT } from '../utils/discussionText.js';
import { discussionError, discussionMatchId, discussionObjectId, discussionObject,
    discussionPost, discussionBoolean, discussionThrough, discussionIds, discussionPage, discussionText,
    discussionFollowingPage, discussionMinePage, discussionSummaryIds } from '../utils/discussions.js';

export const discussionsHeaders = (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store'); res.vary('Authorization'); next();
};
export function discussionsJsonError(error, _req, res, next) {
    if (['entity.parse.failed', 'entity.too.large'].includes(error.type))
        return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ code: 'DISCUSSIONS_INVALID_BODY' });
    next(error);
}
// GET records delivered pages, so it needs the same deletion fence as writes.
// Use a separate request object: do not change the actual HTTP method or auth.
export async function discussionReadLease(req, res) {
    if (req.accountOperation || !req.user) return;
    const leaseRequest = { method: 'POST', baseUrl: req.baseUrl, path: req.path };
    if (!await beginAccountOperation(User, leaseRequest, res, req.user._id, req.user.tokenVersion ?? 0))
        throw discussionError('AUTH_REQUIRED', 401);
    req.accountOperation = leaseRequest.accountOperation;
}

export function createDiscussionsRouter({ service, auth = protect, readLease = discussionReadLease, limits = {}, notify = () => {} }) {
    const router = express.Router();
    router.use(discussionsHeaders);
    const limiter = (max, extra = {}) => rateLimit({ windowMs: 60000, max, standardHeaders: true,
        legacyHeaders: false, message: { code: 'DISCUSSIONS_RATE_LIMIT' }, ...extra });
    router.use(limiter(limits.ip ?? 240));
    router.use(express.json({ limit: DISCUSSION_JSON_LIMIT }), discussionsJsonError);
    const memberLimit = limiter(limits.user ?? 120, { keyGenerator: req => String(req.user._id) });
    const writeLimit = limiter(limits.write ?? 40, { keyGenerator: req => String(req.user._id) });
    const errorResponse = (error, res) => {
        if (res.headersSent || res.destroyed) return;
        const known = /^DISCUSSIONS_/.test(error.code || '') && [400, 401, 403, 404, 409, 429, 503].includes(error.status);
        if (known && error.status === 429) res.set('Retry-After', String(error.retryAfter ?? 60));
        res.status(known ? error.status : 503).json({ code: known ? error.code : 'DISCUSSIONS_UNAVAILABLE' });
    };
    const validate = (fn, paginated = false) => (req, res, next) => {
        try {
            if (!paginated && Object.keys(req.query).length) throw discussionError('INVALID_QUERY', 400);
            fn(req); next();
        } catch (error) { errorResponse(error, res); }
    };
    const optionalAuth = (req, res, next) => req.headers.authorization !== undefined ? auth(req, res, next) : next();
    const optionalLimit = (req, res, next) => req.user ? memberLimit(req, res, next) : next();
    const actor = req => req.user ? { user: req.user._id, tokenVersion: req.user.tokenVersion ?? 0,
        operation: req.accountOperation } : null;
    const handle = (fn, signal) => async (req, res) => {
        try {
            if (req.user && ['GET', 'HEAD'].includes(req.method)) await readLease(req, res);
            if (res.writableEnded || res.destroyed) return;
            const result = await fn(req);
            if (!res.headersSent && !res.destroyed) res.json(result);
            if (signal) { try { void Promise.resolve(notify(signal(req, result))).catch(() => {}); } catch {} }
        } catch (error) { errorResponse(error, res); }
    };
    const match = req => { req.matchTPId = discussionMatchId(req.params.id); };
    const activity = kind => req => ({ kind, actor: String(req.user._id), matchTPId: req.matchTPId, id: req.params.id });
    const comment = req => { discussionObjectId(req.params.id); };
    // Express otherwise runs GET for HEAD but discards its body. That must not
    // count as delivering comments or permit advancing a read watermark.
    router.head('/matches/:id', (_req, res) => res.set('Allow', 'GET, POST').status(405).end());
    // Independent public identity read: no comment delivery/read-watermark mutation.
    router.get('/matches/:id/summary', validate(match), optionalAuth, optionalLimit,
        handle(req => service.summary(req.matchTPId)));
    router.get('/matches/:id', validate(req => { match(req); req.page = discussionPage(req.query); }, true),
        optionalAuth, optionalLimit, handle(req => service.list(actor(req), req.matchTPId, req.page)));
    router.post('/matches/counts', validate(req => discussionIds(req.body)), optionalAuth, optionalLimit,
        handle(req => service.counts(req.body)));
    // Public identity/result only; batching never delivers comments or marks them read.
    router.post('/matches/summaries', validate(req => discussionSummaryIds(req.body)), optionalAuth, optionalLimit,
        handle(req => service.summaries(req.body)));
    router.post('/matches/:id', validate(req => { match(req); discussionPost(req.body); }), auth, memberLimit, writeLimit,
        handle(req => service.post(actor(req), req.matchTPId, req.body), activity('public-match')));
    router.put('/matches/:id/follow', validate(req => { match(req); discussionBoolean(req.body, 'following'); }), auth, memberLimit, writeLimit,
        handle(req => service.follow(actor(req), req.matchTPId, req.body), activity('public-actor')));
    router.put('/matches/:id/read', validate(req => { match(req); discussionThrough(req.body); }), auth, memberLimit,
        handle(req => service.read(actor(req), req.matchTPId, req.body), activity('public-actor')));
    router.get('/notification-summary', validate(() => {}), auth, memberLimit, handle(req => service.notificationSummary(actor(req))));
    router.get('/following', validate(req => discussionFollowingPage(req.query), true), auth, memberLimit,
        handle(req => service.following(actor(req), req.query)));
    router.head('/mine', (_req, res) => res.set('Allow', 'GET').status(405).end());
    router.get('/mine', validate(req => discussionMinePage(req.query), true), auth, memberLimit,
        handle(req => service.mine(actor(req), req.query)));
    router.delete('/comments/:id', validate(req => { comment(req); if (req.body !== undefined) discussionObject(req.body, []); }),
        auth, memberLimit, writeLimit, handle(req => service.remove(actor(req), req.params.id), activity('public-comment')));
    router.post('/comments/:id/report', validate(req => { comment(req); discussionObject(req.body, ['reason']);
        if (req.body.reason !== undefined) discussionText(req.body.reason, 500, true); }), auth, memberLimit, writeLimit,
        handle(req => service.report(actor(req), req.params.id, req.body)));
    router.post('/comments/:id/hide', validate(req => { comment(req); discussionBoolean(req.body, 'hidden'); }), auth, memberLimit, writeLimit,
        handle(req => service.hide(actor(req), req.params.id, req.body), activity('public-comment')));
    router.get('/reports', validate(req => { req.page = discussionPage(req.query, true); }, true), auth, memberLimit,
        handle(req => service.reports(actor(req), req.page)));
    return router;
}
