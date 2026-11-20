import { Router, json } from 'express';
import rateLimit from 'express-rate-limit';
import { insightsOwner, internalInsightsAccount, validateInsightsEvent, insightsUuid, insightsError, INSIGHTS_POLICY } from '../utils/siteInsightsPolicy.js';

export function createSiteInsightsRouter({ store, config, identity, available = () => true, purgeAvailable = available }) {
    const router = Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
    router.use(json({ limit: '2kb' }));
    router.use(rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }));
    const route = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) { res.status(error.status || 503).json({ code: /^SITE_INSIGHTS_[A-Z_]+$/.test(error.code || '') ? error.code : 'SITE_INSIGHTS_UNAVAILABLE' }); }
    };
    const origin = req => {
        if (req.headers.origin !== config.origin) throw insightsError('ORIGIN', 403);
        // A Vercel preview may proxy the same backend; its true Origin must not be admitted.
        if (req.headers['sec-fetch-site'] && !['same-origin', 'same-site'].includes(req.headers['sec-fetch-site'])) throw insightsError('ORIGIN', 403);
    };
    const ready = () => { if (!config.enabled || !available()) throw insightsError('DISABLED', 503); };
    const owner = req => { if (!insightsOwner(req.user)) throw insightsError('FORBIDDEN', req.user ? 403 : 401); };
    router.use(identity);
    router.get('/access', route(async (req, res) => res.json({ allowed: insightsOwner(req.user), internal: internalInsightsAccount(req.user),
        enabled: config.enabled && available(), policy: INSIGHTS_POLICY, emailEnabled: insightsOwner(req.user) && config.emailEnabled })));
    router.post('/view', route(async (req, res) => {
        origin(req); ready(); const event = validateInsightsEvent(req.body);
        const automated = /headless|crawler|spider|\bbot\b|bonzobyte[- ](?:test|check)/i.test(req.headers['user-agent'] || '');
        if (internalInsightsAccount(req.user) || event.excluded === true || automated) return res.json({ accepted: false, excluded: true });
        if (req.user?.accountClosure?.requestedAt) throw insightsError('AUTH_REQUIRED', 401);
        await store.record(event, req.user); res.json({ accepted: true });
    }));
    router.post('/opt-out', route(async (req, res) => {
        origin(req);
        if (!req.body || Object.keys(req.body).some(k => k !== 'visitorId') || (req.body.visitorId !== undefined && !insightsUuid(req.body.visitorId))) throw insightsError('INVALID_EVENT');
        if (req.body.visitorId) {
            // Never acknowledge removal when disconnected or missing the key:
            // the browser must retain its pending-removal receipt and retry.
            if (config.secret.length < 32 || !purgeAvailable()) throw insightsError('REMOVAL_UNAVAILABLE', 503);
            await store.purge(req.body.visitorId);
        }
        res.json({ removed: true });
    }));
    router.get('/summary', route(async (req, res) => {
        owner(req); ready(); const days = String(req.query.days ?? '7');
        if (!['1', '7', '30'].includes(days) || Object.keys(req.query).some(k => k !== 'days')) throw insightsError('INVALID_RANGE');
        res.json(await store.summary(Number(days)));
    }));
    router.get('/notifications', route(async (req, res) => { owner(req); ready(); res.json({ items: await store.notifications() }); }));
    router.post('/notifications/read', route(async (req, res) => {
        origin(req); owner(req); ready(); const ids = req.body?.ids;
        if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
            || Object.keys(req.body).some(k => k !== 'ids')) throw insightsError('INVALID_EVENT');
        await store.markRead(ids); res.json({ updated: true });
    }));
    router.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ code: 'SITE_INSIGHTS_INVALID_REQUEST' }));
    return router;
}
