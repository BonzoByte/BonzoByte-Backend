import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import { discussionsHeaders, discussionsJsonError, discussionReadLease } from './discussions.routes.js';
import { DISCUSSION_JSON_LIMIT } from '../utils/discussionText.js';
import { discussionMatchId, discussionObjectId, discussionPost, discussionPage, discussionBoolean, discussionFollowingPage, discussionThrough } from '../utils/discussions.js';
import { communityTopicInput, communityPage } from '../utils/community.js';
import { moderationPage, moderationScope } from '../utils/communityModeration.js';

export function createCommunityRouter({ service, moderation, auth = protect, readLease = discussionReadLease, enabled = () => false, limits = {} }) {
    const router = express.Router();
    router.use(discussionsHeaders);
    router.use((_req, res, next) => enabled() ? next() : res.status(404).json({ code: 'COMMUNITY_DISABLED' }));
    router.use(rateLimit({ windowMs: 60000, limit: limits.ip || 180, standardHeaders: true, legacyHeaders: false,
        message: { code: 'DISCUSSIONS_RATE_LIMIT' } }));
    router.use(express.json({ limit: DISCUSSION_JSON_LIMIT }), discussionsJsonError);
    const optionalAuth = (req, res, next) => req.headers.authorization !== undefined ? auth(req, res, next) : next();
    const actor = req => req.user ? { user: req.user._id, tokenVersion: req.user.tokenVersion ?? 0, operation: req.accountOperation } : null;
    const error = (e, res) => {
        const known = /^DISCUSSIONS_/.test(e.code || '') && [400, 401, 403, 404, 409, 429, 503].includes(e.status);
        if (!res.headersSent) { if (e.status === 429) res.set('Retry-After', String(e.retryAfter || 60));
            res.status(known ? e.status : 503).json({ code: known ? e.code : 'DISCUSSIONS_UNAVAILABLE' }); }
    };
    const handle = (validate, fn, get = false) => async (req, res) => {
        try {
            if (!get && Object.keys(req.query).length) return res.status(400).json({ code: 'DISCUSSIONS_INVALID_QUERY' });
            validate(req);
            if (req.user && req.method === 'GET') await readLease(req, res);
            if (!res.writableEnded && !res.destroyed) res.json(await fn(req));
        } catch (e) { error(e, res); }
    };
    const id = req => { req.topicId = discussionMatchId(req.params.id); };
    // HEAD must never acquire a read lease or advance a delivered watermark.
    router.use((req, res, next) => req.method === 'HEAD' ? res.status(405).end() : next());
    router.get('/access', optionalAuth, handle(() => {}, req => service.access(actor(req))));
    router.get('/categories', handle(() => {}, () => service.categories()));
    router.get('/following', auth, handle(req => discussionFollowingPage(req.query), req => service.following(actor(req), req.query), true));
    if (moderation) {
        router.get('/moderation/summary', auth, handle(() => {}, req => moderation.summary(actor(req))));
        router.get('/moderation', auth, handle(req => moderationPage(req.query), req => moderation.list(actor(req), req.query), true));
        router.patch('/moderation/:scope/reports/:id', auth, handle(req => { moderationScope(req.params.scope); discussionObjectId(req.params.id); discussionBoolean(req.body, 'resolved'); },
            req => moderation.resolve(actor(req), req.params.scope, req.params.id, req.body.resolved)));
        router.put('/moderation/:scope/comments/:id/hide', auth, handle(req => { moderationScope(req.params.scope); discussionObjectId(req.params.id); discussionBoolean(req.body, 'hidden'); },
            req => moderation.hide(actor(req), req.params.scope, req.params.id, req.body.hidden)));
    }
    router.get('/topics', handle(req => communityPage(req.query), req => service.catalogue(req.query), true));
    router.get('/matches', handle(req => communityPage(req.query, true), req => service.matches(req.query), true));
    router.post('/topics', auth, handle(req => communityTopicInput(req.body), req => service.create(actor(req), req.body)));
    router.get('/topics/:id', optionalAuth, handle(req => { id(req); req.page = discussionPage(req.query); }, req => service.page(actor(req), req.topicId, req.page), true));
    router.post('/topics/:id', auth, handle(req => { id(req); discussionPost(req.body); }, req => service.post(actor(req), req.topicId, req.body)));
    router.put('/topics/:id/follow', auth, handle(req => { id(req); discussionBoolean(req.body, 'following'); }, req => service.follow(actor(req), req.topicId, req.body)));
    router.put('/topics/:id/read', auth, handle(req => { id(req); discussionThrough(req.body); }, req => service.read(actor(req), req.topicId, req.body)));
    router.delete('/topics/:id', auth, handle(id, req => service.removeTopic(actor(req), req.topicId)));
    router.delete('/comments/:id', auth, handle(req => discussionObjectId(req.params.id), req => service.remove(actor(req), req.params.id)));
    router.post('/comments/:id/report', auth, handle(req => discussionObjectId(req.params.id), req => service.report(actor(req), req.params.id, req.body)));
    router.post('/comments/:id/hide', auth, handle(req => { discussionObjectId(req.params.id); discussionBoolean(req.body, 'hidden'); }, req => service.hide(actor(req), req.params.id, req.body.hidden)));
    router.get('/reports', auth, handle(req => { req.page = discussionPage(req.query, true); }, req => service.reports(actor(req), req.page), true));
    return router;
}
