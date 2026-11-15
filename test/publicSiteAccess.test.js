import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import protect from '../middleware/auth.middleware.js';
import { createBetaGate } from '../utils/betaGate.js';
import { isBetaAccountAllowed, publicSiteAccess } from '../utils/accessPolicy.js';

const origin = 'https://bonzobyte.com';
test('public access is explicit; the old invite-only default and development isolation remain', () => {
    const settings = { APP_STAGE: 'beta', BETA_TESTERS: 'invited@example.invalid' };
    assert.equal(isBetaAccountAllowed('new@example.invalid', settings), false);
    for (const mode of ['', 'PUBLIC', 'true', 'invalid'])
        assert.equal(isBetaAccountAllowed('new@example.invalid', { ...settings, SITE_ACCESS_MODE: mode }), false);
    assert.equal(publicSiteAccess({ ...settings, SITE_ACCESS_MODE: 'public' }), true);
    assert.equal(isBetaAccountAllowed('new@example.invalid', { ...settings, SITE_ACCESS_MODE: 'public' }), true);
    assert.equal(publicSiteAccess({ APP_STAGE: 'development', SITE_ACCESS_MODE: 'public' }), false);
});

test('public HTTP entrance needs no code, preserves real account auth/CSRF and disables code mail', async () => {
    const never = new Proxy({}, { get() { assert.fail('public access must not read beta sessions or send codes'); } });
    const app = express(); app.use(express.json());
    app.use(createBetaGate({ access: never, publicOrigin: origin, publicAccess: true }));
    app.get('/api/archives/daily/20261110', (_req, res) => res.json({ sample: true }));
    app.get('/api/auth/google', (_req, res) => res.status(302).set('Location', 'https://accounts.google.com/').end());
    app.post('/api/auth/register', (req, res) => res.json({ emailAccepted: req.body.email }));
    for (const route of ['/api/auth/me', '/api/private-messages/inbox', '/api/favourites', '/api/users/getUserProfile'])
        app.get(route, protect, (_req, res) => res.json({ secret: true }));
    app.use((_req, res) => res.status(404).end());
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        const publicData = await fetch(base + '/api/archives/daily/20261110');
        assert.equal(publicData.status, 200); assert.match(publicData.headers.get('cache-control'), /no-store/);
        assert.equal((await fetch(base + '/api/auth/google', { redirect: 'manual' })).status, 302);
        for (const route of ['/api/auth/me', '/api/private-messages/inbox', '/api/favourites', '/api/users/getUserProfile']) {
            for (const authorization of ['', 'Bearer invalid-token']) {
                const response = await fetch(base + route, { headers: { authorization } });
                assert.equal(response.status, 401); assert.equal((await response.text()).includes('"secret"'), false);
            }
        }
        for (const route of ['/beta', '/beta/request', '/beta/verify', '/beta/logout']) {
            const response = await fetch(base + route, { redirect: 'manual' });
            assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/');
            assert.equal((await fetch(base + route, { method: 'POST', headers: { origin } })).status, 410);
        }
        const compatibility = await fetch(base + '/beta/session');
        assert.deepEqual(await compatibility.json(), { betaAccess: true, siteAccessMode: 'public' });
        for (const bad of ['', 'null', 'https://elsewhere.invalid'])
            assert.equal((await fetch(base + '/api/auth/register', { method: 'POST', headers: { origin: bad } })).status, 403);
        const registration = await fetch(base + '/api/auth/register', { method: 'POST',
            headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new@example.invalid' }) });
        assert.equal(registration.status, 200); assert.deepEqual(await registration.json(), { emailAccepted: 'new@example.invalid' });
        for (const route of ['/api/auth/dev/verify', '/api/auth/debug/routes', '/api/auth/facebook', '/api/auth/google/extra'])
            assert.equal((await fetch(base + route)).status, 404);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('invite-only HTTP gate still denies anonymous archive access by default', async () => {
    const app = express(); app.use(createBetaGate({ publicOrigin: origin, access: { session: async () => null } }));
    app.use((_req, res) => res.json({ secret: true }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/archives/daily/20261110');
        assert.equal(response.status, 401); assert.deepEqual(await response.json(), { code: 'BETA_ACCESS_REQUIRED' });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
