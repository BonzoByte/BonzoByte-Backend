import { Types } from 'mongoose';
import { COMMUNITY_COLLECTIONS } from '../models/community.model.js';
import { DISCUSSION_COLLECTIONS } from '../models/discussion.model.js';
import { discussionError, discussionObjectId, discussionProfile } from './discussions.js';

const scopes = ['forum','match'];
export function moderationScope(scope) {
    if (!scopes.includes(scope)) throw discussionError('INVALID_BODY', 400);
    return scope;
}
export function moderationPage(query = {}) {
    if (Object.keys(query).some(key => !['source','status','after'].includes(key))) throw discussionError('INVALID_QUERY', 400);
    const source = query.source ?? 'all', status = query.status ?? 'open';
    if (!['all',...scopes].includes(source) || !['all','open','resolved'].includes(status)) throw discussionError('INVALID_QUERY', 400);
    let after = null;
    if (query.after !== undefined) {
        try {
            if (typeof query.after !== 'string' || query.after.length > 120) throw 0;
            const value = JSON.parse(Buffer.from(query.after, 'base64url').toString());
            if (!Array.isArray(value) || value.length !== 2 || !scopes.includes(value[0])
                || Buffer.from(JSON.stringify(value)).toString('base64url') !== query.after) throw 0;
            discussionObjectId(value[1]); after = { scope: value[0], id: value[1] };
        } catch { throw discussionError('INVALID_QUERY', 400); }
    }
    return { source, status, after, limit: 20 };
}
const cursor = row => Buffer.from(JSON.stringify([row.scope, row.id])).toString('base64url');
const oid = value => new Types.ObjectId(value);

/** Only public discussion collections are addressable; private-message collections are never queried. */
export function createCommunityModeration({ connection, store, available = () => true, forumNames = COMMUNITY_COLLECTIONS,
    matchNames = DISCUSSION_COLLECTIONS, notify = () => {} }) {
    const names = scope => moderationScope(scope) === 'forum' ? forumNames : matchNames;
    const check = () => { if (!available()) throw discussionError('UNAVAILABLE'); };
    const tx = (actor, work, operation) => { check(); return store.transact(actor, work, { admin: true, operation }); };
    const opts = session => ({ session, maxTimeMS: 15000 });
    async function counts(session) {
        const result = {};
        for (const scope of scopes) result[scope] = await connection.collection(names(scope).reports).countDocuments({ resolved: { $ne: true } }, opts(session));
        return { ...result, total: result.forum + result.match };
    }
    async function previews(entries, session) {
        if (!entries.length) return [];
        const comments = new Map(), threads = new Map(), profileIds = new Map();
        for (const scope of scopes) {
            const selected = entries.filter(entry => entry.scope === scope);
            if (!selected.length) continue;
            const collections = names(scope);
            const commentRows = await connection.collection(collections.comments).find({ _id: { $in: selected.map(entry => entry.row.commentId) } }, opts(session)).toArray();
            const threadRows = await connection.collection(collections.threads).find({ _id: { $in: selected.map(entry => entry.row.matchTPId) } }, opts(session)).toArray();
            for (const row of commentRows) { comments.set(scope + row._id, row); if (row.userId) profileIds.set(String(row.userId), row.userId); }
            for (const row of threadRows) { threads.set(scope + row._id, row); if (scope === 'forum' && row.userId) profileIds.set(String(row.userId), row.userId); }
        }
        // One bounded profile fetch for the whole page, not four round trips per report.
        const authors = profileIds.size ? await connection.collection('users').find({ _id: { $in: [...profileIds.values()] } },
            { ...opts(session), projection: { nickname: 1, accountClosure: 1 } }).toArray() : [];
        const profiles = new Map(authors.map(author => [String(author._id), discussionProfile(author)]));
        return entries.map(({ row, scope }) => {
            const comment = comments.get(scope + row.commentId), thread = threads.get(scope + row.matchTPId);
            const profile = profiles.get(String(comment?.userId));
            const removedTopic = scope === 'forum' && (!thread || thread.removed === true || !profiles.get(String(thread.userId)));
            const visible = !!comment && !!profile && !comment.hidden && !comment.deleted && !removedTopic;
            // Explicit allowlist. No reporter ID, author ID, email, request hash or private content.
            return { id: String(row._id), scope, commentId: String(row.commentId), threadId: row.matchTPId,
                title: removedTopic ? null : (thread?.title || null), reason: row.reason || '', createdAt: row.createdAt,
                resolved: row.resolved === true, resolvedAt: row.resolvedAt || null,
                comment: { body: visible ? comment.body : '', authorName: visible ? profile.nickname : null,
                    sequence: comment?.sequence ?? null, deleted: !comment || comment.deleted === true || removedTopic,
                    hidden: comment?.hidden === true, available: !!comment && !!profile && !removedTopic } };
        });
    }
    return {
        summary(actor) { return tx(actor, session => counts(session), 'moderation.summary'); },
        list(actor, query) {
            const page = moderationPage(query);
            return tx(actor, async session => {
                const streams = [];
                for (const scope of scopes.filter(scope => page.source === 'all' || page.source === scope)) {
                    const filter = page.status === 'open' ? { resolved: { $ne: true } } : page.status === 'resolved' ? { resolved: true } : {};
                    if (page.after) filter._id = { [scopes.indexOf(scope) > scopes.indexOf(page.after.scope) ? '$lte' : '$lt']: oid(page.after.id) };
                    const rows = await connection.collection(names(scope).reports).find(filter, opts(session)).sort({ _id: -1 }).limit(page.limit + 1).toArray();
                    streams.push(...rows.map(row => ({ row, scope })));
                }
                streams.sort((a,b) => String(b.row._id).localeCompare(String(a.row._id)) || scopes.indexOf(a.scope) - scopes.indexOf(b.scope));
                const items = await previews(streams.slice(0,page.limit), session);
                return { items, openCounts: await counts(session), hasMore: streams.length > page.limit,
                    nextAfter: streams.length > page.limit ? cursor(items.at(-1)) : null };
            }, 'moderation.list');
        },
        async resolve(actor, scope, id, resolved) {
            moderationScope(scope); discussionObjectId(id);
            return tx(actor, async (session, at) => {
                const result = await connection.collection(names(scope).reports).updateOne({ _id: oid(id) },
                    { $set: { resolved, resolvedAt: resolved ? at : null } }, opts(session));
                if (!result.matchedCount) throw discussionError('COMMENT_NOT_FOUND', 404);
                return { id, scope, resolved, openCounts: await counts(session) };
            }, 'moderation.resolve');
        },
        async hide(actor, scope, id, hidden) {
            moderationScope(scope); discussionObjectId(id);
            const result = await tx(actor, async session => {
                const collection = connection.collection(names(scope).comments);
                const row = await collection.findOne({ _id: oid(id) }, opts(session));
                if (!row || row.deleted) throw discussionError('COMMENT_NOT_FOUND', 404);
                const author = await connection.collection('users').findOne({ _id: row.userId },
                    { ...opts(session), projection: { nickname: 1, accountClosure: 1 } });
                if (!discussionProfile(author)) throw discussionError('COMMENT_NOT_FOUND', 404);
                if (scope === 'forum') {
                    const thread = await connection.collection(forumNames.threads).findOne({ _id: row.matchTPId, removed: false }, opts(session));
                    const owner = thread?.userId ? await connection.collection('users').findOne({ _id: thread.userId },
                        { ...opts(session), projection: { nickname: 1, accountClosure: 1 } }) : null;
                    if (!discussionProfile(owner)) throw discussionError('COMMENT_NOT_FOUND', 404);
                }
                await collection.updateOne({ _id: row._id }, { $set: { hidden } }, opts(session));
                return { id, scope, hidden };
            }, 'moderation.hide');
            if (scope === 'match') { try { void Promise.resolve(notify({ kind: 'public-comment', actor: String(actor.user), id })).catch(() => {}); } catch {} }
            return result;
        },
    };
}
