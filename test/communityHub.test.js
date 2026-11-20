import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import { communityModels, COMMUNITY_COLLECTIONS as forum } from '../models/community.model.js';
import { DISCUSSION_COLLECTIONS as match } from '../models/discussion.model.js';
import { createCommunity, communityPage } from '../utils/community.js';
import { createDiscussionStore } from '../utils/discussionStore.js';
import { communityFollowingPipeline } from '../utils/communityFollowing.js';
import { createCommunityModeration, moderationPage, moderationScope } from '../utils/communityModeration.js';
import { createCommunityRouter } from '../routes/community.routes.js';
import { communityModerator } from '../utils/communityPolicy.js';
import User from '../models/user.model.js';

test('moderation input cannot select private collections or inject a query', () => {
    assert.deepEqual(moderationPage({}).source, 'all');
    for (const query of [{ source: 'private' }, { status: { $ne: true } }, { after: 'bad' }, { limit: '999' }]) assert.throws(() => moderationPage(query));
    assert.throws(() => moderationScope('private'));
});
test('topic cursors include pin rank while legacy and canonical-match cursors stay compatible', () => {
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    assert.equal(communityPage({ after: encoded([1,1700000000000,123]) }).after.pinRank, 1);
    assert.equal(communityPage({ after: encoded([1700000000000,123]) }).after.pinRank, 0);
    assert.equal(communityPage({ after: encoded([1700000000000,123]) }, true).after.id, 123);
    for (const rank of [2,-1,true,'1',null]) assert.throws(() => communityPage({ after: encoded([rank,1700000000000,123]) }));
    assert.throws(() => communityPage({ after: encoded([1,1700000000000,123]) }, true));
});

test('real JWT/Mongo: unified public moderation, cursor isolation and canonical forum read/follow rules',
    { skip: !process.env.COMMUNITY_TEST_MONGO, timeout: 180000 }, async () => {
    const database = `BonzoByte_Community_Test_${randomUUID().replaceAll('-', '').slice(0,12)}`, nonce = randomUUID();
    let server, guarded = false, clock = new Date();
    Object.assign(process.env, { JWT_SECRET: randomUUID(), APP_STAGE: 'development', NODE_ENV: 'test',
        COMMUNITY_OWNER_MODERATION: 'true', FRONTEND_URL: 'http://localhost:4206' });
    try {
        await mongoose.connect(process.env.COMMUNITY_TEST_MONGO, { dbName: database, maxPoolSize: 3, serverSelectionTimeoutMS: 15000 });
        const connection = mongoose.connection;
        assert.equal((await connection.db.listCollections().toArray()).length, 0);
        await connection.collection('_community_test_guard').insertOne({ _id: 'owner', nonce }); guarded = true;
        const store = createDiscussionStore({ connection, User, models: communityModels, names: forum, now: () => clock,
            canModerate: communityModerator, followingPipeline: communityFollowingPipeline });
        await store.initialize();
        const service = createCommunity({ connection, store }), notifications = [];
        const moderation = createCommunityModeration({ connection, store, notify: event => notifications.push(event) });
        const ids = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
        await User.collection.insertMany(ids.map((_id, index) => ({ _id, nickname: `Hub fixture ${index}`,
            email: index === 0 ? 'horvat.stanko@gmail.com' : `hub${index}@example.invalid`, isVerified: index !== 2, isAdmin: false, tokenVersion: 0 })));
        const app = express(); app.use('/api/community', createCommunityRouter({ service, moderation, enabled: () => true, limits: { ip: 1000 } }));
        server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}/api/community`;
        const tokens = ids.map(id => jwt.sign({ id: String(id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' }));
        const call = async (path, method = 'GET', body, user = 0) => {
            const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(user === null ? {} : { Authorization: `Bearer ${tokens[user]}` }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return { status: res.status, data: method === 'HEAD' ? null : await res.json() };
        };
        assert.equal((await call('/moderation', 'GET', undefined, null)).status, 401);
        assert.equal((await call('/moderation', 'GET', undefined, 1)).status, 403);
        assert.equal((await call('/moderation', 'GET', undefined, 2)).status, 403);
        assert.equal((await call('/moderation?source=private')).status, 400);
        const created = await call('/topics', 'POST', { title: 'Followed fixture', category: 'play', language: 'en', body: 'Opening post', clientRequestId: randomUUID() });
        assert.equal(created.status, 200); const id = created.data.topic.id;
        const initial = (await call(`/topics/${id}`, 'GET', undefined, null)).data.comments[0];
        assert.equal((await call(`/topics/${id}/follow`, 'PUT', { following: true }, 1)).status, 200);
        let following = (await call('/following', 'GET', undefined, 1)).data;
        assert.equal(following.unreadCount, 1); assert.equal(following.threads[0].category, 'play'); assert.equal(following.threads[0].firstUnreadSequence, 1);
        assert.equal((await call(`/topics/${id}/read`, 'PUT', { through: 1 }, 1)).status, 409);
        assert.equal((await call(`/topics/${id}`, 'HEAD', undefined, 1)).status, 405);
        assert.equal((await call(`/topics/${id}/read`, 'PUT', { through: 1 }, 1)).status, 409);
        await call(`/topics/${id}`, 'GET', undefined, 1);
        assert.equal((await call('/following', 'GET', undefined, 1)).data.unreadCount, 1, 'GET is delivery, not a read receipt');
        assert.equal((await call(`/topics/${id}/read`, 'PUT', { through: 1 }, 1)).status, 200);
        assert.equal((await call('/following', 'GET', undefined, 1)).data.unreadCount, 0);
        clock = new Date(+clock + 6000);
        const second = (await call(`/topics/${id}`, 'POST', { body: 'New owner reply', clientRequestId: randomUUID() })).data.comment;
        assert.equal((await call('/following', 'GET', undefined, 1)).data.unreadCount, 1);
        await call(`/topics/${id}/follow`, 'PUT', { following: false }, 1);
        clock = new Date(+clock + 6000);
        const own = await call(`/topics/${id}`, 'POST', { body: 'My own reply', clientRequestId: randomUUID() }, 1);
        assert.equal(own.data.following, false, 'posting must preserve manual unfollow');
        assert.equal((await call('/following', 'GET', undefined, 1)).data.threads.length, 0);
        assert.equal((await call(`/topics/${id}/read`, 'PUT', { through: 3 }, 1)).status, 409, 'POST is not fetched proof');
        await call(`/topics/${id}/follow`, 'PUT', { following: true }, 1);
        assert.equal((await call(`/topics/${id}/follow`, 'PUT', { following: true }, 2)).status, 403);
        await call(`/comments/${initial.id}/report`, 'POST', { reason: 'Forum fixture report' }, 1);
        const matchComment = new mongoose.Types.ObjectId();
        await connection.collection(match.threads).insertOne({ _id: 777, title: 'Canonical A vs B', latestSequence: 1, lastActivityAt: clock });
        await connection.collection(match.comments).insertOne({ _id: matchComment, matchTPId: 777, userId: ids[0], sequence: 1, body: 'Canonical match comment', deleted: false, hidden: false });
        const collision = (await connection.collection(forum.reports).findOne({}))._id;
        await connection.collection(match.reports).insertOne({ _id: collision, commentId: matchComment, matchTPId: 777, userId: ids[1], reason: 'Match fixture report', createdAt: clock });
        let queue = await call('/moderation'); assert.equal(queue.status, 200); assert.equal(queue.data.items.length, 2);
        assert.deepEqual(queue.data.openCounts, { forum: 1, match: 1, total: 2 });
        assert.equal(JSON.stringify(queue.data).includes('example.invalid'), false); assert.equal(JSON.stringify(queue.data).includes('userId'), false);
        const fr = queue.data.items.find(x => x.scope === 'forum'), mr = queue.data.items.find(x => x.scope === 'match');
        assert.equal(mr.comment.body, 'Canonical match comment');
        assert.equal((await call(`/moderation/match/comments/${matchComment}/hide`, 'PUT', { hidden: true }, 1)).status, 403);
        assert.equal((await call(`/moderation/match/comments/${matchComment}/hide`, 'PUT', { hidden: true })).status, 200);
        assert.equal((await connection.collection(match.comments).findOne({ _id: matchComment })).hidden, true);
        assert.equal((await call('/moderation?source=match')).data.items[0].comment.body, '');
        assert.equal(await connection.collection(forum.comments).countDocuments({ body: 'Canonical match comment' }), 0);
        assert.equal(notifications.length, 1); assert.equal(notifications[0].kind, 'public-comment');
        await call(`/moderation/forum/comments/${second.id}/hide`, 'PUT', { hidden: true });
        assert.equal((await call('/following', 'GET', undefined, 1)).data.unreadCount, 0, 'own and hidden replies are not unread');
        await call(`/moderation/forum/comments/${second.id}/hide`, 'PUT', { hidden: false });
        assert.equal((await call('/following', 'GET', undefined, 1)).data.unreadCount, 1);
        await call(`/moderation/forum/reports/${fr.id}`, 'PATCH', { resolved: true });
        assert.equal((await call('/moderation')).data.items.length, 1);
        assert.equal((await call('/moderation?status=resolved')).data.items[0].scope, 'forum');
        await call(`/moderation/forum/reports/${fr.id}`, 'PATCH', { resolved: false });
        // More than one page, with the same ObjectId in both source streams.
        const extra = Array.from({ length: 24 }, (_, n) => ({ _id: new mongoose.Types.ObjectId(), commentId: matchComment, matchTPId: 777,
            userId: ids[1], reason: `page ${n}`, createdAt: clock }));
        await connection.collection(match.reports).insertMany(extra);
        const seen = new Set(); let after = '';
        do {
            queue = await call('/moderation' + (after ? '?after=' + after : '')); assert.equal(queue.status, 200);
            for (const row of queue.data.items) { const key = row.scope + row.id; assert.ok(!seen.has(key)); seen.add(key); }
            after = queue.data.nextAfter || '';
        } while (after);
        assert.equal(seen.size, 26); assert.ok(seen.has('forum' + collision)); assert.ok(seen.has('match' + collision));
        // More than one whole page of pins, then mixed legacy-missing/false rows.
        const seeded = Array.from({ length: 43 }, (_, n) => ({ _id: 100000000000000+n, title: `Pin fixture ${n}`, category: 'equipment', language: 'en',
            userId: n===42 ? ids[1] : ids[0], removed: false, createdAt: clock, lastActivityAt: new Date(+clock+n*1000), latestSequence: 1,
            ...(n<22 ? { pinned: true, pinnedAt: clock } : n%2 ? { pinned: false } : {}) }));
        await connection.collection(forum.threads).insertMany(seeded);
        await connection.collection(forum.comments).insertMany(seeded.map(row => ({ matchTPId: row._id, sequence: 1, userId: row.userId,
            body: row.title, createdAt: clock, hidden: false, deleted: false })));
        const listed=[]; after='';
        do { const response=await call('/topics?category=equipment'+(after?'&after='+after:''),'GET',undefined,null);
            assert.equal(response.status,200); listed.push(...response.data.items); after=response.data.nextAfter||'';
        } while(after);
        assert.equal(listed.length,43); assert.equal(new Set(listed.map(row=>row.id)).size,43);
        assert.deepEqual(listed.map(row=>row.id),[...seeded.slice(0,22).reverse(),...seeded.slice(22).reverse()].map(row=>row._id));
        assert.equal(listed.slice(0,22).every(row=>row.pinned),true);
        assert.equal(listed.slice(22).every(row=>row.pinned===false),true);
        const target=seeded[42], targetPath=`/topics/${target._id}/pin`;
        assert.equal((await call(targetPath,'PUT',{pinned:true},null)).status,401);
        assert.equal((await call(targetPath,'PUT',{pinned:true},1)).status,403,'even the ordinary topic author cannot pin');
        assert.equal((await call(targetPath,'PUT',{pinned:true},2)).status,403);
        assert.equal((await call(targetPath,'PUT',{pinned:'true'})).status,400);
        assert.equal((await call(targetPath,'PUT',{pinned:true,isAdmin:true})).status,400);
        assert.equal((await call(targetPath+'?scope=match','PUT',{pinned:true})).status,400);
        const commentsBefore=await connection.collection(forum.comments).countDocuments({});
        assert.equal((await call(targetPath,'PUT',{pinned:true})).data.topic.pinned,true);
        const pinnedRow=await connection.collection(forum.threads).findOne({_id:target._id});
        clock=new Date(+clock+2000); await call(targetPath,'PUT',{pinned:true});
        assert.equal(+(await connection.collection(forum.threads).findOne({_id:target._id})).pinnedAt,+pinnedRow.pinnedAt,'repeat pin is idempotent');
        assert.equal(+pinnedRow.lastActivityAt,+target.lastActivityAt);
        assert.equal((await call('/topics?category=equipment')).data.items[0].id,target._id);
        assert.equal((await call(`/topics/${target._id}`,'GET',undefined,null)).data.topic.pinned,true);
        assert.equal(await connection.collection(forum.comments).countDocuments({}),commentsBefore);
        assert.equal(await connection.collection(forum.states).countDocuments({matchTPId:target._id}),0,'pinning does not follow or read a topic');
        assert.equal(notifications.length,1,'pinning emits no match notification');
        assert.equal((await call(targetPath,'PUT',{pinned:false})).data.topic.pinned,false);
        const unpinned=await connection.collection(forum.threads).findOne({_id:target._id});
        assert.equal(unpinned.pinnedAt,undefined); assert.equal(+unpinned.lastActivityAt,+target.lastActivityAt);
        assert.equal((await call('/topics?category=equipment')).data.items[0].id,seeded[21]._id);
        assert.equal((await call('/topics/777/pin','PUT',{pinned:true})).status,404,'canonical match feed is not pinnable here');
        assert.equal((await connection.collection(match.threads).findOne({_id:777})).pinned,undefined);
        await connection.collection(forum.threads).updateOne({_id:target._id},{$set:{removed:true}});
        assert.equal((await call(targetPath,'PUT',{pinned:true})).status,404);
        assert.equal((await User.collection.findOne({ _id: ids[0] })).isAdmin, false);
        assert.equal(await connection.collection(match.states).countDocuments({}), 0, 'forum follow/read grants no match participation');
        await User.collection.updateOne({ _id: ids[0] }, { $set: { accountClosure: { requestedAt: clock } } });
        assert.equal((await call('/following', 'GET', undefined, 1)).data.threads.length, 0, 'closed author topics disappear before cleanup');
        assert.equal((await call('/moderation')).status, 401, 'closing accounts immediately lose moderator access');
        await User.collection.updateOne({ _id: ids[0] }, { $unset: { accountClosure: '' } });
        await call(`/topics/${id}/pin`,'PUT',{pinned:true});
        await call(`/topics/${id}`, 'DELETE');
        assert.equal((await connection.collection(forum.threads).findOne({_id:id})).pinned,false);
        assert.equal((await connection.collection(forum.threads).findOne({_id:id})).pinnedAt,undefined);
        assert.equal((await call('/following', 'GET', undefined, 1)).data.threads.length, 0);
        await User.collection.updateOne({ _id: ids[0] }, { $inc: { tokenVersion: 1 } });
        assert.equal((await call('/moderation')).status, 401, 'stale JWT cannot moderate');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (guarded) {
            const db = mongoose.connection.db; assert.match(db.databaseName, /^BonzoByte_Community_Test_[a-f0-9]{12}$/);
            assert.equal((await db.collection('_community_test_guard').findOne({ _id: 'owner' }))?.nonce, nonce);
            const allowed = new Set(['_community_test_guard','users',...Object.values(forum),...Object.values(match)]);
            for (const row of await db.listCollections().toArray()) assert.ok(allowed.has(row.name));
            await db.dropDatabase();
        }
        await mongoose.disconnect();
    }
});
