import { createHash } from 'node:crypto';
import { discussionMatchSummary } from './discussionMatchSummary.js';
import { resolveDiscussionTitle, safeDiscussionTitle, DISCUSSION_TITLE_TIMEOUT_MS } from './discussionTitles.js';
import { discussionLengthValid } from './discussionText.js';

export const discussionError = (code, status = 503, retryAfter) =>
    Object.assign(new Error(code), { code: `DISCUSSIONS_${code}`, status, retryAfter });
const invalid = kind => { throw discussionError(`INVALID_${kind}`, 400); };
export const validMatchId = value => Number.isSafeInteger(value) && value > 0;
export function discussionMatchId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) || !validMatchId(Number(value))) invalid('ID');
    return Number(value);
}
export function discussionObjectId(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) invalid('ID');
    return value;
}
export function discussionObject(value, allowed, required = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key))
        || required.some(key => !Object.hasOwn(value, key))) invalid('BODY');
    return value;
}
export function discussionText(value, max = 1000, empty = false) {
    // Plain text only; no tag stripping that could silently change a submission.
    if (!discussionLengthValid(value, max) || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) invalid('BODY');
    const text = value.replace(/\r\n?/g, '\n').trim();
    if ((!empty && !text) || !discussionLengthValid(text, max)) invalid('BODY');
    return text;
}
export function discussionPost(body) {
    discussionObject(body, ['body', 'replyToId', 'clientRequestId'], ['body', 'clientRequestId']);
    if (typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientRequestId)) invalid('BODY');
    return { body: discussionText(body.body), clientRequestId: body.clientRequestId,
        replyToId: body.replyToId === undefined ? null : discussionObjectId(body.replyToId) };
}
export function discussionBoolean(body, key) {
    discussionObject(body, [key], [key]);
    if (typeof body[key] !== 'boolean') invalid('BODY');
    return body[key];
}
export function discussionThrough(body) {
    discussionObject(body, ['through'], ['through']);
    if (!Number.isSafeInteger(body.through) || body.through < 0) invalid('BODY');
    return body.through;
}
export function discussionIds(body) {
    discussionObject(body, ['ids'], ['ids']);
    if (!Array.isArray(body.ids) || body.ids.length > 50 || !body.ids.every(validMatchId)
        || new Set(body.ids).size !== body.ids.length) invalid('IDS');
    return body.ids;
}
export function discussionPage(query, reports = false) {
    if (Object.keys(query).some(key => !['after', 'limit'].includes(key))) invalid('QUERY');
    const integer = (value, fallback) => {
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) invalid('QUERY');
        return Number(value);
    };
    const limit = integer(query.limit, 30);
    if (limit < 1 || limit > 50) invalid('QUERY');
    return { limit, after: reports ? (query.after === undefined ? null : discussionObjectId(query.after)) : integer(query.after, 0) };
}
export const discussionFollowingCursor = row => Buffer.from(JSON.stringify([
    row.unread, row.lastActivityAt == null ? null : +new Date(row.lastActivityAt), row.matchTPId,
])).toString('base64url');
export function discussionFollowingPage(query = {}) {
    if (Object.keys(query).some(key => !['after', 'limit'].includes(key))) invalid('QUERY');
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit))
        || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('QUERY');
    if (query.after === undefined) return { after: null, limit };
    try {
        if (typeof query.after !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(query.after)) invalid('QUERY');
        const json = Buffer.from(query.after, 'base64url').toString('utf8'), row = JSON.parse(json);
        if (Buffer.from(JSON.stringify(row)).toString('base64url') !== query.after || !Array.isArray(row) || row.length !== 3
            || typeof row[0] !== 'boolean' || !validMatchId(row[2])
            || (row[1] !== null && (!Number.isSafeInteger(row[1]) || row[1] < 0 || !Number.isFinite(+new Date(row[1]))))) invalid('QUERY');
        return { after: { unread: row[0], lastActivityAt: row[1] === null ? null : new Date(row[1]), matchTPId: row[2] }, limit };
    } catch { invalid('QUERY'); }
}
export const discussionMineCursor = row => Buffer.from(JSON.stringify([
    +new Date(row.lastCommentAt), row.matchTPId,
])).toString('base64url');
export function discussionMinePage(query = {}) {
    if (Object.keys(query).some(key => !['after', 'limit'].includes(key))) invalid('QUERY');
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if ((query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d?$/.test(query.limit)))
        || !Number.isInteger(limit) || limit < 1 || limit > 20) invalid('QUERY');
    if (query.after === undefined) return { after: null, limit };
    try {
        if (typeof query.after !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(query.after)) invalid('QUERY');
        const row = JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8'));
        if (Buffer.from(JSON.stringify(row)).toString('base64url') !== query.after || !Array.isArray(row) || row.length !== 2
            || !Number.isSafeInteger(row[0]) || row[0] < 0 || !Number.isFinite(+new Date(row[0])) || !validMatchId(row[1])) invalid('QUERY');
        return { after: { lastCommentAt: new Date(row[0]), matchTPId: row[1] }, limit };
    } catch { invalid('QUERY'); }
}
export const discussionHash = (matchTPId, input) => createHash('sha256')
    .update(JSON.stringify([matchTPId, input.body, input.replyToId])).digest('hex');

export function discussionProfile(user) {
    if (!user || user.accountClosure?.requestedAt) return null;
    const nickname = typeof user.nickname === 'string' && user.nickname.length <= 80
        && !/[<>@\x00-\x1f\x7f]/u.test(user.nickname) ? user.nickname : 'Member';
    let avatarUrl = null;
    if (typeof user.avatarUrl === 'string' && user.avatarUrl.length <= 2048
        && !/[<>@\s\\]/u.test(user.avatarUrl)) {
        if (/^\/uploads\/[A-Za-z0-9/_.,-]+$/.test(user.avatarUrl)) avatarUrl = user.avatarUrl;
        else { try { const url = new URL(user.avatarUrl);
            if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) avatarUrl = url.href;
        } catch { /* Unsafe or malformed avatars are omitted. */ } }
    }
    return { id: String(user._id), nickname: nickname || 'Member', avatarUrl };
}
export function discussionDTO(row, profiles, parents, actor, admin = false) {
    const removed = row.deleted === true || row.hidden === true;
    const parent = row.replyToId ? parents.get(String(row.replyToId)) : null;
    const parentVisible = !removed && parent && parent.matchTPId === row.matchTPId && !parent.deleted && !parent.hidden;
    const parentProfile = parentVisible ? profiles.get(String(parent.userId)) : null;
    return { id: String(row._id), sequence: row.sequence,
        author: removed ? null : (profiles.get(String(row.userId)) ?? null),
        body: removed ? '' : row.body, createdAt: row.createdAt,
        replyTo: row.replyToId ? { id: String(row.replyToId), authorName: parentProfile?.nickname ?? null,
            body: parentVisible && parentProfile && discussionLengthValid(parent.body) ? parent.body : null } : null,
        deleted: row.deleted === true, hidden: row.hidden === true,
        canDelete: !row.deleted && !!actor?.user && String(row.userId) === String(actor.user),
        canHide: admin && !row.deleted };
}

export function createDiscussionAvailability({ store, warn = message => console.warn(message) }) {
    let ready = false;
    return { available: () => ready, async initialize() {
        ready = false;
        try { await store.initialize(); ready = true; }
        catch { warn('[DISCUSSIONS] unavailable: transaction/index initialization required; no records changed.'); }
    } };
}
export function discussionSummaryIds(body) {
    const ids = discussionIds(body);
    if (ids.length > 20) invalid('IDS');
    return ids;
}
export function createDiscussions({ store, resolver, available = () => true, titleTimeoutMS = DISCUSSION_TITLE_TIMEOUT_MS, summaryTimeoutMS = 5000 }) {
    const check = () => { if (!available()) throw discussionError('UNAVAILABLE'); };
    async function match(id) {
        if (!validMatchId(id)) invalid('ID');
        const thread = await store.getThread(id);
        if (thread) return thread;
        if (!await resolver.exists(id)) throw discussionError('MATCH_NOT_FOUND', 404);
        return null;
    }
    return {
        async summary(id) {
            check(); if (!validMatchId(id)) invalid('ID');
            const rows = await resolver.resolve([id]);
            const match = discussionMatchSummary(rows?.get(id), id);
            if (!match) throw discussionError('MATCH_NOT_FOUND', 404);
            return { match };
        },
        async summaries(body) {
            check(); const ids = discussionSummaryIds(body);
            if (!ids.length) return { matches: [] };
            const controller = new AbortController(); let timer;
            const deadline = new Promise((_resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(discussionError('UNAVAILABLE')); }, Math.max(1, Math.min(5000, summaryTimeoutMS)));
            });
            try {
                const rows = await Promise.race([Promise.resolve().then(() => resolver.resolve(ids, { signal: controller.signal })), deadline]);
                return { matches: ids.map(id => discussionMatchSummary(rows?.get(id), id)).filter(Boolean) };
            } finally { clearTimeout(timer); controller.abort(); }
        },
        async list(actor, id, page) { check(); await match(id); return store.list(actor, id, page); },
        async post(actor, id, body) {
            check(); if (!validMatchId(id)) invalid('ID');
            const input = discussionPost(body), replay = await store.post(actor, id, input);
            if (replay) return replay;
            const thread = await match(id);
            const title = safeDiscussionTitle(thread?.title) ? null : await resolveDiscussionTitle(resolver, id, titleTimeoutMS);
            return store.post(actor, id, input, true, title);
        },
        async counts(body) { check(); return store.counts(discussionIds(body)); },
        async follow(actor, id, body) { check(); const following = discussionBoolean(body, 'following');
            await match(id);
            // Explicit follows may also refresh a missing/stale trusted title on
            // an older thread. Unfollows never wait for optional archive labels.
            const title = following ? await resolveDiscussionTitle(resolver, id, titleTimeoutMS) : null;
            return store.follow(actor, id, following, title); },
        async read(actor, id, body) { check(); const through = discussionThrough(body);
            await match(id); return store.read(actor, id, through); },
        async following(actor, query = {}) { check(); return store.following(actor, discussionFollowingPage(query)); },
        async notificationSummary(actor) { check(); const result = await store.following(actor, { after: null, limit: 1 }); return { unreadCount: result.unreadCount }; },
        async mine(actor, query = {}) { check(); return store.mine(actor, discussionMinePage(query)); },
        async remove(actor, id) { check(); discussionObjectId(id); return store.remove(actor, id); },
        async report(actor, id, body) {
            check(); discussionObjectId(id); discussionObject(body, ['reason']);
            return store.report(actor, id, body.reason === undefined ? '' : discussionText(body.reason, 500, true));
        },
        async hide(actor, id, body) { check(); discussionObjectId(id); return store.hide(actor, id, discussionBoolean(body, 'hidden')); },
        async reports(actor, page) { check(); return store.reports(actor, page); },
    };
}
