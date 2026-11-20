import { createHash } from 'node:crypto';
import { discussionError, discussionObject, discussionText, discussionPost, discussionFollowingPage, discussionBoolean, discussionThrough } from './discussions.js';
import { COMMUNITY_COLLECTIONS } from '../models/community.model.js';
import { DISCUSSION_COLLECTIONS } from '../models/discussion.model.js';
import { safeDiscussionTitle } from './discussionTitles.js';
import { communityModerator } from './communityPolicy.js';

export const COMMUNITY_CATEGORIES = Object.freeze(['matches', 'play', 'equipment', 'terrace']);
const options = { maxTimeMS: 5000, timeoutMS: 5000 };
const fail = () => { throw discussionError('INVALID_BODY', 400); };
export function communityTopicInput(body) {
    discussionObject(body, ['title', 'category', 'language', 'body', 'clientRequestId'], ['title', 'category', 'language', 'body', 'clientRequestId']);
    if (!COMMUNITY_CATEGORIES.includes(body.category) || !['hr', 'en'].includes(body.language)) fail();
    const title = discussionText(body.title, 120);
    if (title.length > 160 || /[\r\n]/.test(title)) fail();
    return { title, category: body.category, language: body.language,
        post: discussionPost({ body: body.body, clientRequestId: body.clientRequestId }) };
}
export function communityPage(query = {}, matchFeed = false) {
    if (Object.keys(query).some(key => !(matchFeed ? ['after'] : ['after', 'category']).includes(key))) fail();
    if (!matchFeed && query.category !== undefined && !COMMUNITY_CATEGORIES.includes(query.category)) fail();
    if (query.after !== undefined && (typeof query.after !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(query.after))) fail();
    let after = null;
    if (query.after) {
        try {
            const row = JSON.parse(Buffer.from(query.after, 'base64url').toString());
            if (!Array.isArray(row) || !(matchFeed ? row.length === 2 : [2,3].includes(row.length))) fail();
            const offset = row.length === 3 ? 1 : 0;
            if ((offset && ![0,1].includes(row[0])) || !Number.isSafeInteger(row[offset]) || row[offset] < 0
                || !Number.isSafeInteger(row[offset+1]) || row[offset+1] <= 0 || !Number.isFinite(+new Date(row[offset]))
                || Buffer.from(JSON.stringify(row)).toString('base64url') !== query.after) fail();
            after = { at: new Date(row[offset]), id: row[offset+1], ...(!matchFeed ? { pinRank: offset ? row[0] : 0 } : {}) };
        } catch { fail(); }
    }
    return { category: query.category, after, limit: 20 };
}
const cursor = (row, matchFeed) => Buffer.from(JSON.stringify([...(matchFeed ? [] : [row.pinned === true ? 1 : 0]), +new Date(row.lastActivityAt), row.id])).toString('base64url');
const cursorFilter = after => after ? { $or: [{ lastActivityAt: { $lt: after.at } },
    { lastActivityAt: after.at, _id: { $lt: after.id } }] } : {};
const topicCursorFilter = after => after ? { $or: [{ pinRank: { $lt: after.pinRank } },
    { pinRank: after.pinRank, ...cursorFilter(after) }] } : {};
const topicId = (actor, key) => Number.parseInt(createHash('sha256').update(JSON.stringify([String(actor.user), key])).digest('hex').slice(0, 12), 16) || 1;

export function createCommunity({ connection, store, available = () => true, names = COMMUNITY_COLLECTIONS, matchNames = DISCUSSION_COLLECTIONS }) {
    const c = key => connection.collection(names[key]);
    const check = () => { if (!available()) throw discussionError('UNAVAILABLE'); };
    const topicDTO = row => ({ id: row._id, title: row.title, category: row.category, language: row.language,
        createdAt: row.createdAt, lastActivityAt: row.lastActivityAt, pinned: row.pinned === true });
    async function topic(id) {
        check();
        const row = await c('threads').findOne({ _id: id, category: { $in: COMMUNITY_CATEGORIES }, removed: false }, options);
        if (!row) throw discussionError('COMMENT_NOT_FOUND', 404);
        if (!await connection.collection('users').findOne({ _id: row.userId, 'accountClosure.requestedAt': { $exists: false } },
            { ...options, projection: { _id: 1 } })) throw discussionError('COMMENT_NOT_FOUND', 404);
        return row;
    }
    async function catalogue(page, matchFeed = false) {
        check();
        const collections = matchFeed ? matchNames : names;
        const rows = await connection.collection(collections.threads).aggregate([
            { $match: { ...(matchFeed ? { _id: { $gt: 0 } } : { category: page.category || { $in: COMMUNITY_CATEGORIES }, removed: false }),
                lastActivityAt: { $type: 'date' } } },
            // Legacy rows without a pinned field sort exactly like explicit false.
            ...(!matchFeed ? [{ $set: { pinRank: { $cond: [{ $eq: ['$pinned', true] }, 1, 0] } } }] : []),
            { $match: matchFeed ? cursorFilter(page.after) : topicCursorFilter(page.after) },
            { $sort: { ...(!matchFeed ? { pinRank: -1 } : {}), lastActivityAt: -1, _id: -1 } },
            ...(!matchFeed ? [{ $lookup: { from: 'users', let: { author: '$userId' }, pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$author'] }, 'accountClosure.requestedAt': { $exists: false } } },
                { $project: { _id: 1 } },
            ], as: 'activeAuthor' } }, { $match: { 'activeAuthor.0': { $exists: true } } }] : []),
            { $lookup: { from: collections.comments, let: { id: '$_id' }, pipeline: [
                { $match: { $expr: { $eq: ['$matchTPId', '$$id'] }, hidden: false, deleted: false } }, { $count: 'count' },
            ], as: 'visible' } },
            { $match: { 'visible.0.count': { $gt: 0 } } }, { $limit: page.limit + 1 },
            { $project: { _id: 1, title: 1, category: 1, language: 1, createdAt: 1, lastActivityAt: 1,
                pinned: 1, commentCount: { $arrayElemAt: ['$visible.count', 0] } } },
        ], options).toArray();
        const items = rows.slice(0, page.limit).map(row => matchFeed
            ? { id: row._id, title: safeDiscussionTitle(row.title), commentCount: row.commentCount, lastActivityAt: row.lastActivityAt }
            : { ...topicDTO(row), commentCount: row.commentCount });
        return { items, hasMore: rows.length > page.limit, nextAfter: rows.length > page.limit ? cursor(items.at(-1), matchFeed) : null };
    }
    return {
        async access(actor) {
            check();
            return store.transact(actor, async (_session, _at, user) => ({ canModerate: communityModerator(user) }), { verified: false, operation: 'community.access' });
        },
        categories: () => ({ categories: COMMUNITY_CATEGORIES }),
        catalogue: query => catalogue(communityPage(query)),
        matches: query => catalogue(communityPage(query, true), true),
        following(actor, query) { check(); return store.following(actor, discussionFollowingPage(query)); },
        async follow(actor, id, body) { const row = await topic(id); return store.follow(actor, id, discussionBoolean(body, 'following'), row.title); },
        async read(actor, id, body) { await topic(id); return store.read(actor, id, discussionThrough(body)); },
        async create(actor, body) {
            check(); const input = communityTopicInput(body), id = topicId(actor, input.post.clientRequestId);
            const context = [input.title, input.category, input.language];
            await store.post(actor, id, input.post, true, input.title, { hashContext: context,
                beforeInsert: async (session, at) => {
                    if (await c('threads').findOne({ _id: id }, { session })) throw discussionError('IDEMPOTENCY_CONFLICT', 409);
                    await c('threads').insertOne({ _id: id, title: input.title, category: input.category, language: input.language,
                        userId: actor.user, createdAt: at, lastActivityAt: at, latestSequence: 0, removed: false, pinned: false }, { session });
                } });
            return { topic: topicDTO(await topic(id)) };
        },
        async page(actor, id, page) {
            const row = await topic(id), result = await store.list(actor, id, page);
            // Fail closed during a legacy local account-erasure handover as well.
            result.comments = result.comments.map(comment => !comment.author && !comment.hidden && !comment.deleted
                ? { ...comment, body: '', deleted: true } : comment);
            return { topic: topicDTO(row), ...result };
        },
        async post(actor, id, body) { await topic(id); return store.post(actor, id, discussionPost(body), true, null, {
            beforeInsert: async session => {
                if (!await c('threads').findOne({ _id: id, removed: false }, { session })) throw discussionError('COMMENT_NOT_FOUND', 404);
            },
        }); },
        async pin(actor, id, body) {
            check(); const pinned = discussionBoolean(body, 'pinned');
            return store.transact(actor, async (session, at) => {
                const row = await c('threads').findOne({ _id: id, category: { $in: COMMUNITY_CATEGORIES }, removed: false }, { session });
                if (!row || !await connection.collection('users').findOne({ _id: row.userId, 'accountClosure.requestedAt': { $exists: false } },
                    { session, projection: { _id: 1 } })) throw discussionError('COMMENT_NOT_FOUND', 404);
                if ((row.pinned === true) !== pinned) await c('threads').updateOne({ _id: id }, pinned
                    ? { $set: { pinned: true, pinnedAt: at } }
                    : { $set: { pinned: false }, $unset: { pinnedAt: '' } }, { session });
                // Editorial metadata only: no comment, activity time, read state or notification is written.
                return { topic: topicDTO({ ...row, pinned }) };
            }, { admin: true, operation: 'community.pin' });
        },
        async removeTopic(actor, id) {
            check();
            return store.transact(actor, async (session, _at, user) => {
                const row = await c('threads').findOne({ _id: id }, { session });
                if (!row || (String(row.userId) !== String(actor.user) && !communityModerator(user))) throw discussionError('FORBIDDEN', 403);
                await c('threads').updateOne({ _id: id }, { $set: { removed: true, title: '', pinned: false }, $unset: { userId: '', pinnedAt: '' } }, { session });
                return { removed: true };
            });
        },
        async remove(actor, id) { check(); return store.remove(actor, id); },
        async report(actor, id, body) { check(); discussionObject(body, ['reason']); return store.report(actor, id, body.reason === undefined ? '' : discussionText(body.reason, 500, true)); },
        async hide(actor, id, hidden) { check(); return store.hide(actor, id, hidden); },
        async reports(actor, page) { check(); return store.reports(actor, page); },
    };
}

export async function eraseCommunity(connection, userId, session, names = COMMUNITY_COLLECTIONS) {
    const { eraseDiscussions } = await import('./discussionCleanup.js');
    await eraseDiscussions(connection, userId, session, names);
    await connection.collection(names.threads).updateMany({ userId }, {
        $set: { title: '', removed: true, pinned: false }, $unset: { userId: '', pinnedAt: '' },
    }, { session });
}

// Only the local sidecar needs this bridge while the older auth process keeps running.
// It erases forum data for gone/closing accounts, never accounts or other app collections.
export async function reconcileCommunityAuthors(connection, User, store) {
    const rows = await connection.collection(COMMUNITY_COLLECTIONS.comments).aggregate([
        { $match: { userId: { $type: 'objectId' } } }, { $group: { _id: '$userId' } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'author' } },
        { $match: { $or: [{ 'author.0': { $exists: false } }, { 'author.0.accountClosure.requestedAt': { $exists: true } }] } },
        { $limit: 20 }, { $project: { _id: 1 } },
    ], options).toArray();
    for (const row of rows) await store.transact(null, async session => {
        const user = await User.collection.findOne({ _id: row._id }, { session, projection: { accountClosure: 1 } });
        if (!user || user.accountClosure?.requestedAt) await eraseCommunity(connection, row._id, session);
    }, { verified: false, operation: 'community.local-erasure' });
}
