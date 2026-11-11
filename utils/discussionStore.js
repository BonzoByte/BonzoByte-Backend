import { Types } from 'mongoose';
import { DISCUSSION_COLLECTIONS } from '../models/discussion.model.js';
import { discussionError, discussionHash, discussionDTO, discussionProfile, discussionFollowingCursor, discussionMineCursor } from './discussions.js';
import { DISCUSSION_MONGO_LIMITS, discussionMonotonicNow, discussionTimeRemaining,
    discussionDiagnostic, initializeDiscussionIndexes } from './discussionMongo.js';
import { safeDiscussionTitle } from './discussionTitles.js';

const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    maxCommitTimeMS: DISCUSSION_MONGO_LIMITS.commitMS };
// A transaction inherits its shared CSOT budget; do not reset it per command.
// Driver 6.15 derives wire maxTimeMS from that remaining budget, overriding
// explicit maxTimeMS/maxCommitTimeMS. All transaction commands and commit thus
// share the same 20s ceiling; standalone reads have a separate 5s ceiling.
const options = session => ({ ...(session ? { session } : { timeoutMS: DISCUSSION_MONGO_LIMITS.readTimeoutMS }),
    maxTimeMS: session ? DISCUSSION_MONGO_LIMITS.commandMS : DISCUSSION_MONGO_LIMITS.readTimeoutMS });
const visible = { deleted: false, hidden: false };
const objectId = value => new Types.ObjectId(value);
const versionQuery = version => version === 0
    ? { $or: [{ tokenVersion: 0 }, { tokenVersion: null }] } : { tokenVersion: version };
const profileProjection = { _id: 1, nickname: 1, avatarUrl: 1, accountClosure: 1 };

export function discussionFollowingPipeline(userId, names = DISCUSSION_COLLECTIONS, { after = null, limit = 100 } = {}) {
    const cursor = after ? [{ $match: { $or: [
        ...(after.unread ? [{ unread: false }] : []),
        ...(after.lastActivityAt ? [
            { unread: after.unread, lastActivityAt: { $lt: after.lastActivityAt } },
            { unread: after.unread, lastActivityAt: null },
        ] : []),
        { unread: after.unread, lastActivityAt: after.lastActivityAt, matchTPId: { $gt: after.matchTPId } },
    ] } }] : [];
    return [
        { $match: { userId, following: true } },
        { $lookup: { from: names.comments, let: { match: '$matchTPId', read: '$readThrough' }, pipeline: [
            { $match: { ...visible, $expr: { $and: [{ $eq: ['$matchTPId', '$$match'] },
                { $gt: ['$sequence', '$$read'] }, { $ne: ['$userId', userId] }] } } },
            { $limit: 1 }, { $project: { _id: 1 } },
        ], as: 'pending' } },
        { $lookup: { from: names.threads, localField: 'matchTPId', foreignField: '_id', as: 'thread' } },
        { $project: { _id: 0, matchTPId: 1, readThrough: 1,
            title: { $ifNull: [{ $arrayElemAt: ['$thread.title', 0] }, null] },
            unread: { $gt: [{ $size: '$pending' }, 0] },
            latestSequence: { $ifNull: [{ $arrayElemAt: ['$thread.latestSequence', 0] }, 0] },
            lastActivityAt: { $ifNull: [{ $arrayElemAt: ['$thread.lastActivityAt', 0] }, null] } } },
        { $facet: {
            totals: [{ $match: { unread: true } }, { $count: 'unreadCount' }],
            threads: [...cursor, { $sort: { unread: -1, lastActivityAt: -1, matchTPId: 1 } }, { $limit: limit + 1 }],
        } },
    ];
}

// Reuse the canonical unread rules, restricted to this owner's displayed page.
// Do not infer unread state from activity timestamps or change read watermarks.
export function discussionUnreadForMatchesPipeline(userId, matchIds, names = DISCUSSION_COLLECTIONS) {
    if (!Array.isArray(matchIds) || matchIds.length > 20 || new Set(matchIds).size !== matchIds.length
        || matchIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new TypeError('Invalid discussion page');
    const pipeline = discussionFollowingPipeline(userId, names, { limit: 20 });
    pipeline[0].$match.matchTPId = { $in: matchIds };
    return pipeline;
}

// Filter by the authenticated owner before grouping; never scan other users or
// infer participation from a follow/read. No read watermarks are touched here.
export function discussionMinePipeline(userId, names = DISCUSSION_COLLECTIONS, { after = null, limit = 20 } = {}) {
    return [
        { $match: { userId, ...visible } },
        { $group: { _id: '$matchTPId', lastCommentAt: { $max: '$createdAt' }, commentCount: { $sum: 1 } } },
        ...(after ? [{ $match: { $or: [
            { lastCommentAt: { $lt: after.lastCommentAt } },
            { lastCommentAt: after.lastCommentAt, _id: { $gt: after.matchTPId } },
        ] } }] : []),
        { $sort: { lastCommentAt: -1, _id: 1 } }, { $limit: limit + 1 },
        { $lookup: { from: names.threads, localField: '_id', foreignField: '_id', as: 'thread' } },
        { $project: { _id: 0, matchTPId: '$_id', lastCommentAt: 1, commentCount: 1,
            title: { $ifNull: [{ $arrayElemAt: ['$thread.title', 0] }, null] } } },
    ];
}

export function createDiscussionStore({ connection, User, models = [], names = DISCUSSION_COLLECTIONS, now = () => new Date(),
    diagnostic = () => {}, clock = discussionMonotonicNow }) {
    const c = key => connection.collection(names[key]);
    async function initialize() {
        // Native, bounded, additive index creation: never sync/drop/repair rows.
        await initializeDiscussionIndexes({ connection, models, diagnostic, clock });
    }
    async function transact(actor, fn, { verified = true, admin = false, operation = 'write' } = {}) {
        if (actor && (!actor.user || !actor.operation?.id || !Number.isInteger(actor.operation.tokenVersion)
            || actor.operation.tokenVersion < 0 || actor.tokenVersion !== actor.operation.tokenVersion))
            throw discussionError('AUTH_REQUIRED', 401);
        const started = clock(); let attempts = 0;
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    const timeoutMS = discussionTimeRemaining(started, DISCUSSION_MONGO_LIMITS.transactionMS, clock);
                    const result = await connection.transaction(async session => {
                        attempts++;
                        discussionTimeRemaining(started, DISCUSSION_MONGO_LIMITS.transactionMS, clock);
                        const at = now(); let user = null;
                        if (actor) {
                            // One round trip both claims the fence and reads the
                            // current profile/permissions; no JWT role shortcuts.
                            user = await User.collection.findOneAndUpdate({ _id: actor.user,
                                ...versionQuery(actor.operation.tokenVersion), 'accountClosure.requestedAt': { $exists: false },
                                accountOperations: { $elemMatch: { id: actor.operation.id, expiresAt: { $gt: at } } } },
                            { $set: { 'accountOperations.$.expiresAt': new Date(+at + 120000) },
                                $inc: { 'accountOperations.$.discussionWrites': 1 } }, { ...options(session),
                                returnDocument: 'after', includeResultMetadata: false,
                                projection: { ...profileProjection, isAdmin: 1, isVerified: 1 } });
                            if (!user) throw discussionError('AUTH_REQUIRED', 401);
                            if (verified && user.isVerified !== true) throw discussionError('VERIFICATION_REQUIRED', 403);
                            if (admin && user.isAdmin !== true) throw discussionError('ADMIN_REQUIRED', 403);
                        } else if (verified || admin) throw discussionError('AUTH_REQUIRED', 401);
                        return fn(session, at, user);
                    }, { ...transactionOptions, timeoutMS });
                    discussionDiagnostic(diagnostic, operation, clock() - started, null, attempts);
                    return result;
                } catch (error) {
                    // Duplicate-key retries share ONE 20s budget, not 3 x 20s.
                    // Driver conflict/commit retries inherit the remaining CSOT.
                    if (error.code !== 11000 || attempt >= 2) throw error;
                }
            }
        } catch (error) {
            discussionDiagnostic(diagnostic, operation, clock() - started, error, attempts); throw error;
        }
    }
    const stateQuery = (actor, matchTPId) => ({ userId: actor.user, matchTPId });
    async function stateFor(actor, matchTPId, session) {
        return await c('states').findOne(stateQuery(actor, matchTPId), options(session))
            ?? { ...stateQuery(actor, matchTPId), following: false, readThrough: 0, fetchedThrough: 0 };
    }
    async function saveState(state, session) {
        const { _id, ...fields } = state;
        await c('states').updateOne({ userId: state.userId, matchTPId: state.matchTPId }, { $set: fields },
            { ...options(session), upsert: true });
    }
    async function dto(rows, actor, user, session) {
        const parentIds = rows.map(row => row.replyToId).filter(Boolean);
        const parents = parentIds.length ? await c('comments').find({ _id: { $in: parentIds } }, options(session)).toArray() : [];
        const ids = [...rows, ...parents].filter(row => !row.deleted && !row.hidden).map(row => row.userId)
            .filter(id => id && String(id) !== String(user?._id));
        const profiles = ids.length ? await User.collection.find({ _id: { $in: ids } },
            { ...options(session), projection: profileProjection }).toArray() : [];
        if (user) profiles.push(user); // Already read by the fence in THIS snapshot.
        const profileMap = new Map(profiles.map(profile => [String(profile._id), discussionProfile(profile)]));
        const parentMap = new Map(parents.map(parent => [String(parent._id), parent]));
        return rows.map(row => discussionDTO(row, profileMap, parentMap, user?.isVerified === true ? actor : null,
            user?.isAdmin === true && user?.isVerified === true));
    }
    async function metadata(matchTPId, state, session, knownThread) {
        const thread = knownThread ?? await c('threads').findOne({ _id: matchTPId }, options(session));
        return { matchTPId, following: state?.following === true, readThrough: state?.readThrough ?? 0,
            latestSequence: thread?.latestSequence ?? 0,
            total: await c('comments').countDocuments({ matchTPId, ...visible }, options(session)) };
    }
    async function consume(actor, kind, at, session) {
        const row = await c('spam').findOne({ _id: actor.user }, options(session));
        const recent = (row?.[kind] ?? []).filter(date => +date > +at - 3600000);
        const max = kind === 'posts' ? 30 : 20, gap = kind === 'posts' ? 5000 : 1000;
        const last = recent.at(-1);
        if (recent.length >= max || (last && +at - +last < gap)) {
            const until = recent.length >= max ? +recent[0] + 3600000 : +last + gap;
            throw discussionError('RATE_LIMIT', 429, Math.max(1, Math.ceil((until - +at) / 1000)));
        }
        await c('spam').updateOne({ _id: actor.user }, { $set: { [kind]: [...recent, at] } },
            { ...options(session), upsert: true });
    }
    async function getThread(matchTPId) {
        return c('threads').findOne({ _id: matchTPId }, { ...options(), projection: { _id: 1, title: 1 } });
    }
    const hasThread = async matchTPId => !!await getThread(matchTPId);
    async function list(actor, matchTPId, { after, limit }) {
        return transact(actor, async (session, _at, user) => {
            const rows = await c('comments').find({ matchTPId, sequence: { $gt: after } }, options(session))
                .sort({ sequence: 1 }).limit(limit + 1).toArray();
            const comments = rows.slice(0, limit), state = actor ? await stateFor(actor, matchTPId, session) : null;
            // Only extend contiguous delivered history. An arbitrary high cursor,
            // a lookahead row, or the thread's latestSequence is not proof of fetch.
            if (state && comments.length && after <= state.fetchedThrough) {
                state.fetchedThrough = Math.max(state.fetchedThrough, comments.at(-1).sequence);
                await saveState(state, session);
            }
            return { ...await metadata(matchTPId, state, session), comments: await dto(comments, actor, user, session),
                hasMore: rows.length > limit, nextAfter: comments.at(-1)?.sequence ?? after };
        }, { verified: false, operation: 'list' });
    }
    async function post(actor, matchTPId, input, matchExists, trustedTitle = null) {
        return transact(actor, async (session, at, user) => {
            const requestHash = discussionHash(matchTPId, input);
            const previous = await c('comments').findOne({ userId: actor.user, clientRequestId: input.clientRequestId }, options(session));
            if (previous) {
                if (previous.requestHash !== requestHash) throw discussionError('IDEMPOTENCY_CONFLICT', 409);
                return { comment: (await dto([previous], actor, user, session))[0], replayed: true,
                    ...await metadata(matchTPId, await stateFor(actor, matchTPId, session), session) };
            }
            if (matchExists !== true) return null;
            const replyToId = input.replyToId ? objectId(input.replyToId) : null;
            if (replyToId) {
                const parent = await c('comments').findOne({ _id: replyToId, matchTPId, ...visible }, options(session));
                if (!parent || parent.replyToId) throw discussionError('INVALID_REPLY', 400);
            }
            await consume(actor, 'posts', at, session);
            const title = safeDiscussionTitle(trustedTitle);
            const thread = await c('threads').findOneAndUpdate({ _id: matchTPId },
                { $inc: { latestSequence: 1 }, $set: { lastActivityAt: at, ...(title ? { title } : {}) } }, { ...options(session), upsert: true,
                    returnDocument: 'after', includeResultMetadata: false });
            if (!Number.isSafeInteger(thread.latestSequence)) throw discussionError('UNAVAILABLE');
            const row = { _id: new Types.ObjectId(), matchTPId, sequence: thread.latestSequence,
                userId: actor.user, body: input.body, createdAt: at, replyToId,
                deleted: false, hidden: false, clientRequestId: input.clientRequestId, requestHash };
            await c('comments').insertOne(row, options(session));
            const state = await stateFor(actor, matchTPId, session);
            if (!state.firstPostAt) {
                state.firstPostAt = at;
                if (state.manualFollowing !== false) state.following = true;
            }
            await saveState(state, session);
            return { comment: (await dto([row], actor, user, session))[0], replayed: false,
                ...await metadata(matchTPId, state, session, thread) };
        }, { operation: matchExists === true ? 'post.persist' : 'post.replay-check' });
    }
    async function counts(ids) {
        if (!ids.length) return { counts: [] };
        const rows = await c('comments').aggregate([{ $match: { matchTPId: { $in: ids }, ...visible } },
            { $group: { _id: '$matchTPId', count: { $sum: 1 } } }], options()).toArray();
        const counts = new Map(rows.map(row => [row._id, row.count]));
        return { counts: ids.map(matchTPId => ({ matchTPId, count: counts.get(matchTPId) ?? 0 })) };
    }
    async function follow(actor, matchTPId, following, trustedTitle = null) {
        return transact(actor, async session => {
            const state = await stateFor(actor, matchTPId, session);
            state.following = following; state.manualFollowing = following;
            await saveState(state, session);
            const title = safeDiscussionTitle(trustedTitle);
            if (following && title) await c('threads').updateOne({ _id: matchTPId }, {
                $set: { title }, $setOnInsert: { latestSequence: 0, lastActivityAt: null },
            }, { ...options(session), upsert: true });
            return { matchTPId, following, readThrough: state.readThrough };
        }, { operation: 'follow' });
    }
    async function read(actor, matchTPId, through) {
        return transact(actor, async session => {
            const state = await stateFor(actor, matchTPId, session);
            if (through > state.fetchedThrough) throw discussionError('NOT_FETCHED', 409);
            state.readThrough = Math.max(state.readThrough, through);
            await saveState(state, session);
            return { matchTPId, following: state.following, readThrough: state.readThrough };
        }, { operation: 'read' });
    }
    async function following(actor, page = { after: null, limit: 100 }) {
        return transact(actor, async session => {
            const [result] = await c('states').aggregate(discussionFollowingPipeline(actor.user, names, page), options(session)).toArray();
            const rows = result?.threads ?? [], threads = rows.slice(0, page.limit).map(row => ({ ...row, title: safeDiscussionTitle(row.title) })),
                hasMore = rows.length > page.limit;
            return { unreadCount: result?.totals[0]?.unreadCount ?? 0, threads, hasMore,
                nextAfter: hasMore ? discussionFollowingCursor(threads.at(-1)) : null };
        }, { verified: false, operation: 'following' });
    }
    async function mine(actor, page = { after: null, limit: 20 }) {
        if (!actor?.user) throw discussionError('AUTH_REQUIRED', 401);
        return transact(actor, async session => {
            const rows = await c('comments').aggregate(discussionMinePipeline(actor.user, names, page),
                { ...options(session), allowDiskUse: false }).toArray();
            // Explicit response allowlist, even if the aggregation changes later.
            const threads = rows.slice(0, page.limit).map(row => ({ matchTPId: row.matchTPId,
                lastCommentAt: row.lastCommentAt, commentCount: row.commentCount, title: safeDiscussionTitle(row.title), unread: false }));
            if (threads.length) {
                const [activity] = await c('states').aggregate(discussionUnreadForMatchesPipeline(actor.user,
                    threads.map(row => row.matchTPId), names), options(session)).toArray();
                const unread = new Set((activity?.threads ?? []).filter(row => row.unread === true).map(row => row.matchTPId));
                for (const thread of threads) thread.unread = unread.has(thread.matchTPId);
            }
            const hasMore = rows.length > page.limit;
            return { threads, hasMore, nextAfter: hasMore ? discussionMineCursor(threads.at(-1)) : null };
        }, { verified: false, operation: 'mine' });
    }
    async function target(id, session) {
        const row = await c('comments').findOne({ _id: objectId(id) }, options(session));
        if (!row) throw discussionError('COMMENT_NOT_FOUND', 404);
        return row;
    }
    async function remove(actor, id) {
        return transact(actor, async (session, _at, user) => {
            const row = await target(id, session);
            if (String(row.userId) !== String(actor.user)) throw discussionError('FORBIDDEN', 403);
            await c('comments').updateOne({ _id: row._id }, { $set: { deleted: true, body: '' } }, options(session));
            return { comment: (await dto([{ ...row, deleted: true, body: '' }], actor, user, session))[0] };
        }, { operation: 'remove' });
    }
    async function report(actor, id, reason) {
        return transact(actor, async (session, at) => {
            const row = await target(id, session);
            const query = { userId: actor.user, commentId: row._id };
            if (await c('reports').findOne(query, options(session))) return { reported: true };
            if (row.deleted || row.hidden) throw discussionError('COMMENT_NOT_FOUND', 404);
            await consume(actor, 'reports', at, session);
            // Conflict with the author's erasure/hide/delete before retaining any
            // report reference to that author. Re-read on transaction retry.
            await c('comments').updateOne({ _id: row._id }, { $inc: { reportRevision: 1 } }, options(session));
            await c('reports').insertOne({ ...query, authorId: row.userId, matchTPId: row.matchTPId, reason, createdAt: at }, options(session));
            return { reported: true };
        }, { operation: 'report' });
    }
    async function hide(actor, id, hidden) {
        return transact(actor, async (session, _at, user) => {
            const row = await target(id, session);
            await c('comments').updateOne({ _id: row._id }, { $set: { hidden } }, options(session));
            return { comment: (await dto([{ ...row, hidden }], actor, user, session))[0] };
        }, { admin: true, operation: 'hide' });
    }
    async function reports(actor, { after, limit }) {
        return transact(actor, async session => {
            const rows = await c('reports').find(after ? { _id: { $lt: objectId(after) } } : {}, options(session))
                .sort({ _id: -1 }).limit(limit + 1).toArray();
            const page = rows.slice(0, limit);
            // Explicit allowlist: not even admins receive reporter identity.
            return { reports: page.map(row => ({ id: String(row._id), commentId: String(row.commentId),
                matchTPId: row.matchTPId, reason: row.reason, createdAt: row.createdAt })),
            hasMore: rows.length > limit, nextAfter: page.length ? String(page.at(-1)._id) : after };
        }, { verified: false, admin: true, operation: 'reports' });
    }
    return { initialize, getThread, hasThread, list, post, counts, follow, read, following, mine, remove, report, hide, reports };
}
