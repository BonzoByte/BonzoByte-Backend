import { createHash } from 'node:crypto';
import { discussionError, discussionObject, discussionText, discussionPost, discussionMatchId } from './discussions.js';
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
            if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0
                || !Number.isSafeInteger(row[1]) || row[1] <= 0 || !Number.isFinite(+new Date(row[0]))
                || Buffer.from(JSON.stringify(row)).toString('base64url') !== query.after) fail();
            after = { at: new Date(row[0]), id: row[1] };
        } catch { fail(); }
    }
    return { category: query.category, after, limit: 20 };
}
const cursor = row => Buffer.from(JSON.stringify([+new Date(row.lastActivityAt), row.id])).toString('base64url');
const cursorFilter = after => after ? { $or: [{ lastActivityAt: { $lt: after.at } },
    { lastActivityAt: after.at, _id: { $lt: after.id } }] } : {};
const topicId = (actor, key) => Number.parseInt(createHash('sha256').update(JSON.stringify([String(actor.user), key])).digest('hex').slice(0, 12), 16) || 1;

export function createCommunity({ connection, store, available = () => true, names = COMMUNITY_COLLECTIONS, matchNames = DISCUSSION_COLLECTIONS }) {
    const c = key => connection.collection(names[key]);
    const check = () => { if (!available()) throw discussionError('UNAVAILABLE'); };
    const topicDTO = row => ({ id: row._id, title: row.title, category: row.category, language: row.language,
        createdAt: row.createdAt, lastActivityAt: row.lastActivityAt });
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
                lastActivityAt: { $type: 'date' }, ...cursorFilter(page.after) } },
            { $sort: { lastActivityAt: -1, _id: -1 } },
            ...(!matchFeed ? [{ $lookup: { from: 'users', let: { author: '$userId' }, pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$author'] }, 'accountClosure.requestedAt': { $exists: false } } },
                { $project: { _id: 1 } },
            ], as: 'activeAuthor' } }, { $match: { 'activeAuthor.0': { $exists: true } } }] : []),
            { $lookup: { from: collections.comments, let: { id: '$_id' }, pipeline: [
                { $match: { $expr: { $eq: ['$matchTPId', '$$id'] }, hidden: false, deleted: false } }, { $count: 'count' },
            ], as: 'visible' } },
            { $match: { 'visible.0.count': { $gt: 0 } } }, { $limit: page.limit + 1 },
            { $project: { _id: 1, title: 1, category: 1, language: 1, createdAt: 1, lastActivityAt: 1,
                commentCount: { $arrayElemAt: ['$visible.count', 0] } } },
        ], options).toArray();
        const items = rows.slice(0, page.limit).map(row => matchFeed
            ? { id: row._id, title: safeDiscussionTitle(row.title), commentCount: row.commentCount, lastActivityAt: row.lastActivityAt }
            : { ...topicDTO(row), commentCount: row.commentCount });
        return { items, hasMore: rows.length > page.limit, nextAfter: rows.length > page.limit ? cursor(items.at(-1)) : null };
    }
    return {
        async access(actor) {
            check();
            return store.transact(actor, async (_session, _at, user) => ({ canModerate: communityModerator(user) }), { verified: false, operation: 'community.access' });
        },
        categories: () => ({ categories: COMMUNITY_CATEGORIES }),
        catalogue: query => catalogue(communityPage(query)),
        matches: query => catalogue(communityPage(query, true), true),
        async create(actor, body) {
            check(); const input = communityTopicInput(body), id = topicId(actor, input.post.clientRequestId);
            const context = [input.title, input.category, input.language];
            await store.post(actor, id, input.post, true, input.title, { hashContext: context,
                beforeInsert: async (session, at) => {
                    if (await c('threads').findOne({ _id: id }, { session })) throw discussionError('IDEMPOTENCY_CONFLICT', 409);
                    await c('threads').insertOne({ _id: id, title: input.title, category: input.category, language: input.language,
                        userId: actor.user, createdAt: at, lastActivityAt: at, latestSequence: 0, removed: false }, { session });
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
        async removeTopic(actor, id) {
            check();
            return store.transact(actor, async (session, _at, user) => {
                const row = await c('threads').findOne({ _id: id }, { session });
                if (!row || (String(row.userId) !== String(actor.user) && !communityModerator(user))) throw discussionError('FORBIDDEN', 403);
                await c('threads').updateOne({ _id: id }, { $set: { removed: true, title: '' }, $unset: { userId: '' } }, { session });
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
        $set: { title: '', removed: true }, $unset: { userId: '' },
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
