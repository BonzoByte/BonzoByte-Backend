import { Router } from 'express';

// Mount ONLY for Mongo storage. Terminal misses prevent stale local-file fallback.
export function createMongoAvatarRouter({ storage, prefix = 'avatars' }) {
    const router = Router();
    router.use((_req, res, next) => {
        res.set({ 'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store',
            'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
        next();
    });
    router.get(`/${prefix}/:userId/:filename`, async (req, res) => {
        const key = `${prefix}/${req.params.userId}/${req.params.filename}`;
        try { storage.parseKey(key); }
        catch { return res.status(404).end(); }
        try {
            const avatar = await storage.readAvatar(key);
            if (!avatar) return res.status(404).end();
            res.set('ETag', avatar.etag);
            const tags = String(req.get('If-None-Match') || '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
            if (tags.includes('*') || tags.includes(avatar.etag)) return res.status(304).end();
            res.set({ 'Content-Type': 'image/webp', 'Content-Length': String(avatar.buffer.length) });
            return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(avatar.buffer);
        } catch {
            // Do not expose database diagnostics or avatar/account identifiers.
            return res.status(503).end();
        }
    });
    router.use((_req, res) => res.status(404).end());
    router.use((_err, _req, res, _next) => res.status(404).end());
    return router;
}
