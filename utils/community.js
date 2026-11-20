import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { discussionError, discussionObject, discussionText, discussionPost, discussionFollowingPage, discussionBoolean, discussionThrough, discussionObjectId } from './discussions.js';
import { COMMUNITY_COLLECTIONS, CommunityReaction } from '../models/community.model.js';
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
export function communityEditInput(body) {
    discussionObject(body, ['body','version'], ['body','version']);
    if (!Number.isSafeInteger(body.version) || body.version < 0 || body.version > 1000000000) fail();
    return { body: discussionText(body.body), version: body.version };
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
    async function reactions(comments, actor, session) {
        const ids = comments.filter(row => !row.deleted && !row.hidden && row.author).map(row => new Types.ObjectId(row.id));
        const rows = ids.length ? await c('reactions').aggregate([
            { $match: { commentId: { $in: ids } } },
            { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'reactor' } },
            { $match: { 'reactor.0': { $exists: true }, 'reactor.accountClosure.requestedAt': { $exists: false } } },
            { $group: { _id: '$commentId', count: { $sum: 1 }, liked: { $max: { $cond: [{ $eq: ['$userId', actor?.user ?? null] }, 1, 0] } } } },
        ], session ? { session } : options).toArray() : [];
        const byId = new Map(rows.map(row => [String(row._id), { count: row.count, liked: row.liked === 1 }]));
        return comments.map(row => ({ ...row, reaction: byId.get(row.id) ?? { count: 0, liked: false } }));
    }
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
        async initialize() {
            const indexes = CommunityReaction.schema.indexes().map(([key, settings]) => {
                const { _autoIndex, ...rest } = settings; return { key, ...rest };
            });
            await c('reactions').createIndexes(indexes, { maxTimeMS: 30000, timeoutMS: 30000 });
        },
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
                ? { ...comment, body: '', deleted: true, editedAt: undefined, editVersion: undefined } : comment);
            return { topic: topicDTO(row), ...result, comments: await reactions(result.comments, actor) };
        },
        async post(actor, id, body) { await topic(id); const result = await store.post(actor, id, discussionPost(body), true, null, {
            beforeInsert: async session => {
                if (!await c('threads').findOne({ _id: id, removed: false }, { session })) throw discussionError('COMMENT_NOT_FOUND', 404);
            },
        }); return { ...result, comment: (await reactions([result.comment], actor))[0] }; },
        async react(actor, id, body) {
            check(); discussionObjectId(id); const liked = discussionBoolean(body, 'liked');
            return store.transact(actor, async (session, at) => {
                const row = await c('comments').findOne({ _id: new Types.ObjectId(id), deleted: false, hidden: false }, { session });
                if (!row) throw discussionError('COMMENT_NOT_FOUND', 404);
                const thread = await c('threads').findOne({ _id: row.matchTPId, removed: false, category: { $in: COMMUNITY_CATEGORIES } }, { session });
                const active = userId => connection.collection('users').findOne({ _id: userId,
                    'accountClosure.requestedAt': { $exists: false } }, { session, projection: { _id: 1 } });
                if (!thread || !await active(thread.userId) || !await active(row.userId)) throw discussionError('COMMENT_NOT_FOUND', 404);
                if (String(row.userId) === String(actor.user)) throw discussionError('FORBIDDEN', 403);
                const query = { commentId: row._id, userId: actor.user };
                const previous = await c('reactions').findOne(query, { session });
                if (!!previous !== liked) {
                    const spam = await c('spam').findOne({ _id: actor.user }, { session });
                    const recent = (spam?.reactions ?? []).filter(date => +date > +at - 3600000);
                    if (recent.length >= 120) {
                        const until = +recent[0] + 3600000;
                        throw discussionError('RATE_LIMIT', 429, Math.max(1, Math.ceil((until - +at) / 1000)));
                    }
                    await c('spam').updateOne({ _id: actor.user }, { $set: { reactions: [...recent, at] } }, { session, upsert: true });
                    // Serialize with hide/delete, topic removal and author erasure. No activity/read/follow/notification writes.
                    await c('comments').updateOne({ _id: row._id }, { $inc: { reactionRevision: 1 } }, { session });
                    await c('threads').updateOne({ _id: thread._id }, { $inc: { reactionFence: 1 } }, { session });
                    if (liked) await c('reactions').insertOne({ ...query, authorId: row.userId, matchTPId: row.matchTPId, createdAt: at }, { session });
                    else await c('reactions').deleteOne(query, { session });
                }
                const [result] = await reactions([{ id, author: { id: String(row.userId) } }], actor, session);
                return { commentId: id, reaction: result.reaction };
            }, { operation: 'community.react' });
        },
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
        async edit(actor, id, body) {
            check(); discussionObjectId(id); const input = communityEditInput(body);
            return store.transact(actor, async (session, at) => {
                const row = await c('comments').findOne({ _id: new Types.ObjectId(id) }, { session });
                if (!row) throw discussionError('COMMENT_NOT_FOUND', 404);
                // Ownership is mandatory even for administrators/moderators.
                if (String(row.userId) !== String(actor.user)) throw discussionError('FORBIDDEN', 403);
                if (row.deleted || row.hidden) throw discussionError('COMMENT_NOT_FOUND', 404);
                const thread = await c('threads').findOne({ _id: row.matchTPId, removed: false, category: { $in: COMMUNITY_CATEGORIES } }, { session });
                if (!thread || !await connection.collection('users').findOne({ _id: thread.userId, 'accountClosure.requestedAt': { $exists: false } },
                    { session, projection: { _id: 1 } })) throw discussionError('COMMENT_NOT_FOUND', 404);
                const version = row.editVersion ?? 0;
                const response = () => ({ comment: { id, threadId: row.matchTPId, body: row.body, editedAt: row.editedAt ?? null, editVersion: version } });
                // Retry after a lost response confirms the same revision, never rewrites it.
                if (version === input.version+1 && row.body === input.body) return response();
                if (version !== input.version) throw discussionError('EDIT_CONFLICT', 409);
                if (row.body === input.body) return response();
                const spam = await c('spam').findOne({ _id: actor.user }, { session });
                const recent = (spam?.edits ?? []).filter(date => +date > +at-3600000), last = recent.at(-1);
                if (recent.length >= 30 || (last && +at-+last < 5000)) {
                    const until = recent.length >= 30 ? +recent[0]+3600000 : +last+5000;
                    throw discussionError('RATE_LIMIT', 429, Math.max(1, Math.ceil((until-+at)/1000)));
                }
                await c('spam').updateOne({ _id: actor.user }, { $set: { edits: [...recent,at] } }, { session, upsert: true });
                // Share a write fence with topic removal/account erasure. No activity,
                // sequence, following, fetched/read watermark or notification changes.
                await c('threads').updateOne({ _id: thread._id }, { $inc: { editFence: 1 } }, { session });
                await c('comments').updateOne({ _id: row._id }, { $set: { body: input.body, editedAt: at, editVersion: version+1 } }, { session });
                return { comment: { id, threadId: row.matchTPId, body: input.body, editedAt: at, editVersion: version+1 } };
            }, { operation: 'community.edit' });
        },
        async removeTopic(actor, id) {
            check();
            return store.transact(actor, async (session, _at, user) => {
                const row = await c('threads').findOne({ _id: id }, { session });
                if (!row || (String(row.userId) !== String(actor.user) && !communityModerator(user))) throw discussionError('FORBIDDEN', 403);
                await c('threads').updateOne({ _id: id }, { $set: { removed: true, title: '', pinned: false }, $unset: { userId: '', pinnedAt: '' } }, { session });
                await c('reactions').deleteMany({ matchTPId: id }, { session });
                return { removed: true };
            });
        },
        async remove(actor, id) { check(); return store.remove(actor, id, {
            afterRemove: (session, row) => c('reactions').deleteMany({ commentId: row._id }, { session }),
        }); },
        async report(actor, id, body) { check(); discussionObject(body, ['reason']); return store.report(actor, id, body.reason === undefined ? '' : discussionText(body.reason, 500, true)); },
        async hide(actor, id, hidden) { check(); return store.hide(actor, id, hidden); },
        async reports(actor, page) { check(); return store.reports(actor, page); },
    };
}

export async function eraseCommunity(connection, userId, session, names = COMMUNITY_COLLECTIONS) {
    const { eraseDiscussions } = await import('./discussionCleanup.js');
    await eraseDiscussions(connection, userId, session, names);
    // Remove both this account's reactions and reactions on its erased posts/topics.
    const owned = await connection.collection(names.threads).find({ userId }, { session, projection: { _id: 1 } }).toArray();
    await connection.collection(names.reactions).deleteMany({ $or: [{ userId }, { authorId: userId },
        { matchTPId: { $in: owned.map(row => row._id) } }] }, { session });
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
