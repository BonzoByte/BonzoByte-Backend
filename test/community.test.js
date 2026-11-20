import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import { communityModels, COMMUNITY_COLLECTIONS } from '../models/community.model.js';
import { DISCUSSION_COLLECTIONS } from '../models/discussion.model.js';
import { createCommunity, communityTopicInput, communityPage, eraseCommunity } from '../utils/community.js';
import { createDiscussionStore } from '../utils/discussionStore.js';
import { createCommunityRouter } from '../routes/community.routes.js';
import User from '../models/user.model.js';
import { communityModerator } from '../utils/communityPolicy.js';

test('community-only owner moderation is explicit, verified and never inferred from a similar email', () => {
    const owner = { email: 'horvat.stanko@gmail.com', isVerified: true, isAdmin: false };
    assert.equal(communityModerator(owner, {}), false);
    assert.equal(communityModerator(owner, { COMMUNITY_OWNER_MODERATION: 'true' }), true);
    assert.equal(communityModerator({ ...owner, isVerified: false }, { COMMUNITY_OWNER_MODERATION: 'true' }), false);
    assert.equal(communityModerator({ ...owner, email: 'fake+horvat.stanko@gmail.com' }, { COMMUNITY_OWNER_MODERATION: 'true' }), false);
    assert.equal(communityModerator({ ...owner, accountClosure: { requestedAt: new Date() } }, { COMMUNITY_OWNER_MODERATION: 'true' }), false);
    assert.equal(communityModerator({ email: 'external@example.invalid', isVerified: true, isAdmin: true }, {}), true);
});

test('four sections, strict plain text, language and replay key validation', () => {
    const body = { title: 'Igramo tenis?', body: 'Bjelovar, vikend', language: 'hr', category: 'play', clientRequestId: 'test-1' };
    assert.equal(communityTopicInput(body).title, body.title);
    for (const bad of [{ ...body, category: 'private' }, { ...body, title: '<script>' }, { ...body, title: 'a\nb' },
        { ...body, title: 'a'.repeat(121) }, { ...body, language: 'xx' }, { ...body, userId: 'forged' }, { ...body, body: 'x'.repeat(1001) }])
        assert.throws(() => communityTopicInput(bad), e => e.status === 400);
});
test('pagination is bounded and cursor cannot inject a query', () => {
    assert.equal(communityPage({ category: 'matches' }).limit, 20);
    for (const query of [{ limit: '99999' }, { category: { $ne: '' } }, { after: 'not-valid' }, { after: ['x'] }])
        assert.throws(() => communityPage(query));
    assert.throws(() => communityPage({ category: 'play' }, true));
});
test('community namespace cannot appear in match participation/DM tables', () => {
    assert.equal(new Set([...Object.values(COMMUNITY_COLLECTIONS), ...Object.values(DISCUSSION_COLLECTIONS)]).size, 10);
});
test('disabled router is closed by default', async () => {
    const app = express(); app.use('/api/community', createCommunityRouter({ service: {} }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/community/topics`); assert.equal(response.status, 404); }
    finally { await new Promise(resolve => server.close(resolve)); }
});

test('Mongo + real JWT + router: posting, replay, moderation, match linking and account erasure',
    { skip: !process.env.COMMUNITY_TEST_MONGO, timeout: 180000 }, async () => {
    const database = `BonzoByte_Community_Test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    assert.match(database, /^BonzoByte_Community_Test_[a-f0-9]{12}$/);
    let server, guarded = false; const nonce = randomUUID(); let clock = new Date();
    process.env.JWT_SECRET = randomUUID(); process.env.APP_STAGE = 'development'; process.env.NODE_ENV = 'test';
    process.env.COMMUNITY_OWNER_MODERATION = 'true';
    process.env.FRONTEND_URL = 'http://localhost:4206';
    try {
        await mongoose.connect(process.env.COMMUNITY_TEST_MONGO, { dbName: database, maxPoolSize: 3, serverSelectionTimeoutMS: 15000 });
        const connection = mongoose.connection; assert.equal((await connection.db.listCollections().toArray()).length, 0);
        await connection.collection('_community_test_guard').insertOne({ _id: 'owner', nonce }); guarded = true;
        const store = createDiscussionStore({ connection, User, models: communityModels, names: COMMUNITY_COLLECTIONS, now: () => clock, canModerate: communityModerator });
        await store.initialize();
        const service = createCommunity({ connection, store });
        const ids = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
        await User.collection.insertMany(ids.map((_id, index) => ({ _id, nickname: `Fixture ${index}`, email: index === 0 ? 'horvat.stanko@gmail.com' : `fixture${index}@example.invalid`,
            isVerified: index !== 2, isAdmin: index === 3, tokenVersion: 0, isUser: true })));
        const app = express(); app.use('/api/community', createCommunityRouter({ service, enabled: () => true, limits: { ip: 1000 } }));
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}/api/community`;
        const token = index => jwt.sign({ id: String(ids[index]), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
        const call = async (path, method = 'GET', body, index = null) => {
            const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(index === null ? {} : { Authorization: `Bearer ${token(index)}` }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            const data = method === 'HEAD' ? null : await res.json(); return { status: res.status, data };
        };
        const input = { title: 'Local test topic', body: 'First post', category: 'play', language: 'en', clientRequestId: randomUUID() };
        assert.equal((await call('/topics', 'POST', input)).status, 401);
        assert.equal((await call('/topics', 'POST', input, 2)).status, 403);
        const created = await call('/topics', 'POST', input, 0); assert.equal(created.status, 200);
        const id = created.data.topic.id;
        assert.equal((await call('/access', 'GET', undefined, 0)).data.canModerate, true);
        assert.equal((await call('/access', 'GET', undefined, 1)).data.canModerate, false);
        assert.equal((await call('/access')).data.canModerate, false);
        assert.equal((await call('/topics', 'POST', input, 0)).data.topic.id, id);
        assert.equal((await call('/topics', 'POST', { ...input, category: 'terrace' }, 0)).status, 409);
        let page = (await call(`/topics/${id}`)).data; assert.equal(page.comments.length, 1); assert.equal(page.comments[0].author.email, undefined);
        const first = page.comments[0].id;
        clock = new Date(+clock + 6000);
        const reply = { body: 'Reply', clientRequestId: randomUUID(), replyToId: first };
        const posted = await call(`/topics/${id}`, 'POST', reply, 1); assert.equal(posted.status, 200);
        assert.equal((await call(`/topics/${id}`, 'POST', reply, 1)).data.replayed, true);
        assert.equal((await call(`/topics/${id}`, 'POST', { ...reply, body: 'changed' }, 1)).status, 409);
        assert.equal((await call(`/comments/${first}`, 'DELETE', undefined, 1)).status, 403);
        assert.equal((await call(`/comments/${first}/hide`, 'POST', { hidden: true }, 1)).status, 403);
        assert.equal((await call(`/comments/${first}/report`, 'POST', { reason: 'test' }, 1)).status, 200);
        assert.equal((await call('/reports', 'GET', undefined, 1)).status, 403);
        assert.equal((await call('/reports', 'GET', undefined, 3)).data.reports.length, 1);
        assert.equal((await call('/reports', 'GET', undefined, 0)).data.reports.length, 1);
        assert.equal((await call(`/comments/${first}/hide`, 'POST', { hidden: true }, 3)).status, 200);
        page = (await call(`/topics/${id}`)).data; assert.equal(page.comments[0].body, ''); assert.equal(page.comments[0].author, null);
        assert.equal((await call(`/topics/${id}`, 'GET', undefined, 0)).data.comments[1].canHide, true);
        assert.equal(page.comments[1].replyTo.body, null);
        const listing = (await call('/topics?category=play')).data; assert.equal(listing.items[0].commentCount, 1);
        assert.equal(JSON.stringify(listing).includes(String(ids[0])), false);
        assert.equal((await call(`/topics/${id}`, 'HEAD')).status, 405);
        // Canonical match IDs only: feed never copies comment bodies or private messages.
        await connection.collection(DISCUSSION_COLLECTIONS.threads).insertMany([{ _id: 123, title: 'A vs B', latestSequence: 1, lastActivityAt: clock },
            { _id: 456, title: 'Hidden match', latestSequence: 1, lastActivityAt: clock }]);
        await connection.collection(DISCUSSION_COLLECTIONS.comments).insertMany([{ matchTPId: 123, body: 'Public body not copied', deleted: false, hidden: false },
            { matchTPId: 456, body: 'Secret hidden body', deleted: false, hidden: true }]);
        const matches = (await call('/matches')).data; assert.deepEqual(matches.items.map(x => x.id), [123]);
        assert.equal(JSON.stringify(matches).includes('body'), false);
        assert.equal(await connection.collection(DISCUSSION_COLLECTIONS.states).countDocuments({}), 0);
        assert.equal((await call(`/topics/${id}`, 'DELETE', undefined, 1)).status, 403);
        assert.equal((await call(`/topics/${id}`, 'DELETE', undefined, 0)).status, 200);
        clock = new Date(+clock + 6000); assert.equal((await call(`/topics/${id}`, 'POST', { body: 'late', clientRequestId: randomUUID() }, 1)).status, 404);
        assert.equal((await call('/topics?category=play')).data.items.length, 0);
        // Erasure shares the enclosing user-fenced transaction; no copied identity survives.
        await connection.transaction(session => eraseCommunity(connection, ids[1], session));
        assert.equal(await connection.collection(COMMUNITY_COLLECTIONS.comments).countDocuments({ userId: ids[1] }), 0);
        assert.equal(await connection.collection(COMMUNITY_COLLECTIONS.reports).countDocuments({ userId: ids[1] }), 0);
        assert.equal(await connection.collection(COMMUNITY_COLLECTIONS.states).countDocuments({ userId: ids[1] }), 0);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (guarded) {
            const db = mongoose.connection.db; assert.match(db.databaseName, /^BonzoByte_Community_Test_[a-f0-9]{12}$/);
            assert.equal((await db.collection('_community_test_guard').findOne({ _id: 'owner' }))?.nonce, nonce);
            const allowed = new Set(['_community_test_guard', 'users', ...Object.values(COMMUNITY_COLLECTIONS), ...Object.values(DISCUSSION_COLLECTIONS)]);
            for (const collection of await db.listCollections().toArray()) assert.ok(allowed.has(collection.name));
            await db.dropDatabase();
        }
        await mongoose.disconnect();
    }
});
