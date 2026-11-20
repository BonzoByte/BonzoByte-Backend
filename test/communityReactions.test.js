import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';
import { communityModels, CommunityReaction, COMMUNITY_COLLECTIONS as names } from '../models/community.model.js';
import { DISCUSSION_COLLECTIONS as match } from '../models/discussion.model.js';
import { createDiscussionStore } from '../utils/discussionStore.js';
import { createCommunity, eraseCommunity } from '../utils/community.js';
import { createCommunityRouter } from '../routes/community.routes.js';
import { communityModerator } from '../utils/communityPolicy.js';

test('forum reactions have a unique per-comment/account key and erasure indexes, isolated from matches', () => {
    assert.notEqual(names.reactions, match.comments);
    const indexes = CommunityReaction.schema.indexes();
    assert.ok(indexes.some(([key, opts]) => key.commentId === 1 && key.userId === 1 && opts.unique));
    for (const key of ['userId', 'authorId', 'matchTPId']) assert.ok(indexes.some(([row]) => Object.keys(row).length === 1 && row[key] === 1));
});

test('Mongo/JWT: like/unlike, replay, concurrency, visibility, no activity changes and account erasure',
    { skip: !process.env.COMMUNITY_TEST_MONGO, timeout: 180000 }, async () => {
    const database = 'BonzoByte_Community_Test_' + randomUUID().replaceAll('-', '').slice(0, 12), nonce = randomUUID();
    let server, guarded = false, clock = new Date();
    Object.assign(process.env, { JWT_SECRET: randomUUID(), APP_STAGE: 'development', NODE_ENV: 'test', COMMUNITY_OWNER_MODERATION: 'true', FRONTEND_URL: 'http://localhost:4206' });
    try {
        await mongoose.connect(process.env.COMMUNITY_TEST_MONGO, { dbName: database, maxPoolSize: 10, serverSelectionTimeoutMS: 15000 });
        const connection = mongoose.connection;
        assert.equal((await connection.db.listCollections().toArray()).length, 0);
        await connection.collection('_community_test_guard').insertOne({ _id: 'owner', nonce }); guarded = true;
        const store = createDiscussionStore({ connection, User, names, models: communityModels, now: () => clock, canModerate: communityModerator });
        await store.initialize(); const service = createCommunity({ connection, store }); await service.initialize();
        const ids = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
        await User.collection.insertMany(ids.map((_id, n) => ({ _id, nickname: 'Reaction fixture ' + n,
            email: n === 0 ? 'horvat.stanko@gmail.com' : `reaction${n}@example.invalid`, tokenVersion: 0, isVerified: n !== 3, isAdmin: false })));
        const tokens = ids.map(id => jwt.sign({ id: String(id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' }));
        const app = express(); app.use('/api/community', createCommunityRouter({ service, enabled: () => true, limits: { ip: 1000 } }));
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}/api/community`;
        const call = async (path, method = 'GET', body, user = 1) => {
            const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(user === null ? {} : { Authorization: 'Bearer ' + tokens[user] }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return { status: res.status, data: await res.json() };
        };
        const created = await call('/topics', 'POST', { title: 'Reaction topic', category: 'play', language: 'en', body: 'A useful comment', clientRequestId: randomUUID() }, 0);
        assert.equal(created.status, 200); const topic = created.data.topic.id;
        const pagePath = `/topics/${topic}`;
        const page = (await call(pagePath)).data, first = page.comments[0].id, endpoint = `/comments/${first}/reaction`;
        assert.deepEqual(page.comments[0].reaction, { count: 0, liked: false });
        assert.equal((await call(endpoint, 'PUT', { liked: true }, null)).status, 401);
        assert.equal((await call(endpoint, 'PUT', { liked: true }, 3)).status, 403);
        assert.equal((await call(endpoint, 'PUT', { liked: true }, 0)).status, 403, 'no self reactions, including moderator');
        for (const body of [{}, { liked: 'true' }, { liked: 1 }, { liked: true, userId: String(ids[2]) }, { liked: true, count: 100 }])
            assert.equal((await call(endpoint, 'PUT', body)).status, 400);
        assert.equal((await call(endpoint + '?userId=forged', 'PUT', { liked: true })).status, 400);
        const states = await connection.collection(names.states).find({}).sort({ _id: 1 }).toArray();
        const thread = await connection.collection(names.threads).findOne({ _id: topic });
        const comment = await connection.collection(names.comments).findOne({ _id: new mongoose.Types.ObjectId(first) });
        let result = await call(endpoint, 'PUT', { liked: true });
        assert.equal(result.status, 200); assert.deepEqual(result.data, { commentId: first, reaction: { count: 1, liked: true } });
        const originalReaction = await connection.collection(names.reactions).findOne({ userId: ids[1] });
        const concurrent = await Promise.all([call(endpoint, 'PUT', { liked: true }), call(endpoint, 'PUT', { liked: true })]);
        assert.ok(concurrent.every(row => row.status === 200 && row.data.reaction.count === 1));
        assert.deepEqual(await connection.collection(names.reactions).findOne({ userId: ids[1] }), originalReaction, 'retry never recreates the reaction');
        assert.equal((await call(endpoint, 'PUT', { liked: true }, 2)).data.reaction.count, 2);
        assert.deepEqual(await connection.collection(names.states).find({}).sort({ _id: 1 }).toArray(), states);
        const after = await connection.collection(names.threads).findOne({ _id: topic }); delete after.reactionFence;
        assert.deepEqual(after, thread, 'reactions never bump topic activity, sequence or follow/read state');
        const afterComment = await connection.collection(names.comments).findOne({ _id: comment._id }); delete afterComment.reactionRevision;
        assert.deepEqual(afterComment, comment, 'body, creation/edit time and sequence remain unchanged');
        assert.deepEqual((await call(pagePath, 'GET', undefined, null)).data.comments[0].reaction, { count: 2, liked: false });
        assert.deepEqual((await call(pagePath)).data.comments[0].reaction, { count: 2, liked: true });
        assert.equal(JSON.stringify(result.data).includes(String(ids[1])), false, 'no reactor identity in responses');
        assert.equal((await call(endpoint, 'PUT', { liked: false })).data.reaction.count, 1);
        assert.equal((await call(endpoint, 'PUT', { liked: false })).data.reaction.count, 1);
        await connection.collection(names.spam).updateOne({ _id: ids[1] }, { $set: { reactions: Array(120).fill(clock) } }, { upsert: true });
        assert.equal((await call(endpoint, 'PUT', { liked: true })).status, 429);
        await connection.collection(names.spam).updateOne({ _id: ids[1] }, { $set: { reactions: [] } });
        assert.equal((await call(endpoint, 'PUT', { liked: true })).data.reaction.count, 2);
        await call(endpoint, 'PUT', { liked: false });
        await call(endpoint, 'PUT', { liked: false }, 2);
        const distinct = await Promise.all([call(endpoint, 'PUT', { liked: true }), call(endpoint, 'PUT', { liked: true }, 2)]);
        assert.ok(distinct.every(row => row.status === 200), 'different accounts can react concurrently');
        assert.equal((await call(pagePath, 'GET', undefined, null)).data.comments[0].reaction.count, 2);
        await call(`/comments/${first}/hide`, 'POST', { hidden: true }, 0);
        assert.equal((await call(endpoint, 'PUT', { liked: false })).status, 404);
        assert.deepEqual((await call(pagePath, 'GET', undefined, null)).data.comments[0].reaction, { count: 0, liked: false });
        await call(`/comments/${first}/hide`, 'POST', { hidden: false }, 0);
        assert.equal((await call(pagePath)).data.comments[0].reaction.count, 2);
        await User.collection.updateOne({ _id: ids[1] }, { $set: { accountClosure: { requestedAt: clock } } });
        assert.equal((await call(endpoint, 'PUT', { liked: false })).status, 401);
        assert.equal((await call(pagePath, 'GET', undefined, null)).data.comments[0].reaction.count, 1, 'closing/deleted reactors are not counted');
        await connection.transaction(session => eraseCommunity(connection, ids[1], session));
        assert.equal(await connection.collection(names.reactions).countDocuments({ userId: ids[1] }), 0);
        await User.collection.updateOne({ _id: ids[2] }, { $inc: { tokenVersion: 1 } });
        assert.equal((await call(endpoint, 'PUT', { liked: false }, 2)).status, 401);
        await User.collection.updateOne({ _id: ids[2] }, { $set: { tokenVersion: 0 } });
        const canonical = new mongoose.Types.ObjectId();
        await connection.collection(match.comments).insertOne({ _id: canonical, body: 'Canonical match comment', deleted: false, hidden: false });
        assert.equal((await call(`/comments/${canonical}/reaction`, 'PUT', { liked: true }, 2)).status, 404);
        clock = new Date(+clock + 6000);
        const reply = await call(pagePath, 'POST', { body: 'Another comment', clientRequestId: randomUUID() }, 0);
        assert.equal(reply.status, 200); const replyId = reply.data.comment.id;
        assert.equal((await call(`/comments/${replyId}/reaction`, 'PUT', { liked: true }, 2)).status, 200);
        await call(`/comments/${replyId}`, 'DELETE', undefined, 0);
        assert.equal(await connection.collection(names.reactions).countDocuments({ commentId: new mongoose.Types.ObjectId(replyId) }), 0);
        assert.equal((await call(`/comments/${replyId}/reaction`, 'PUT', { liked: true }, 2)).status, 404);
        clock = new Date(+clock + 6000);
        const extra = await call('/topics', 'POST', { title: 'Removed reaction topic', category: 'play', language: 'en', body: 'Temporary', clientRequestId: randomUUID() }, 0);
        assert.equal(extra.status, 200);
        const extraId = extra.data.topic.id, extraPage = await call(`/topics/${extraId}`, 'GET', undefined, null);
        assert.equal(extraPage.status, 200); const extraComment = extraPage.data.comments[0].id;
        assert.equal((await call(`/comments/${extraComment}/reaction`, 'PUT', { liked: true }, 2)).status, 200);
        await call(`/topics/${extraId}`, 'DELETE', undefined, 0);
        assert.equal(await connection.collection(names.reactions).countDocuments({ matchTPId: extraId }), 0);
        assert.equal((await call(`/comments/${extraComment}/reaction`, 'PUT', { liked: false }, 2)).status, 404);
        await User.collection.updateOne({ _id: ids[0] }, { $set: { accountClosure: { requestedAt: clock } } });
        assert.equal((await call(endpoint, 'PUT', { liked: false }, 2)).status, 404);
        await connection.transaction(session => eraseCommunity(connection, ids[0], session));
        assert.equal(await connection.collection(names.reactions).countDocuments({}), 0, 'author/topic erasure removes related reactions');
        assert.equal((await connection.collection(match.comments).findOne({ _id: canonical })).body, 'Canonical match comment');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (guarded) {
            const db = mongoose.connection.db; assert.match(db.databaseName, /^BonzoByte_Community_Test_[a-f0-9]{12}$/);
            assert.equal((await db.collection('_community_test_guard').findOne({ _id: 'owner' }))?.nonce, nonce);
            const allowed = new Set(['_community_test_guard', 'users', ...Object.values(names), ...Object.values(match)]);
            for (const row of await db.listCollections().toArray()) assert.ok(allowed.has(row.name));
            await db.dropDatabase();
        }
        await mongoose.disconnect();
    }
});
