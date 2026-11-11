import { Types } from 'mongoose';
import { DISCUSSION_COLLECTIONS } from '../models/discussion.model.js';
import { PRIVATE_MESSAGE_COLLECTIONS } from '../models/privateMessages.model.js';
const valid = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
const invalid = () => Object.assign(new Error('Invalid presence request'), { code: 'PRESENCE_INVALID_QUERY', status: 400 });

/** Only bounded contextual reads; there is deliberately no arbitrary user-ID lookup. */
export function parsePresenceContexts(query) {
    if (!query || Object.keys(query).length !== 1 || typeof query.contexts !== 'string' || query.contexts.length > 8000) throw invalid();
    let rows; try { rows = JSON.parse(query.contexts); } catch { throw invalid(); }
    if (!Array.isArray(rows) || !rows.length || rows.length > 20) throw invalid();
    let ids = 0; const keys = new Set();
    return rows.map(row => {
        if (!Array.isArray(row) || row.length !== 3 || !['d', 'p'].includes(row[0]) || !Array.isArray(row[2])
            || !row[2].length || row[2].length > 100 || !row[2].every(valid) || new Set(row[2]).size !== row[2].length) throw invalid();
        if (row[0] === 'd' ? !Number.isSafeInteger(row[1]) || row[1] <= 0 : !valid(row[1])) throw invalid();
        const key = row[0] + ':' + row[1]; ids += row[2].length;
        if (keys.has(key) || ids > 100) throw invalid(); keys.add(key);
        return { kind: row[0], id: row[1], userIds: row[2] };
    });
}

export function createPresenceReader({ connection, User, hub, eligible = () => true }) {
    const object = id => new Types.ObjectId(id);
    return async (viewer, contexts) => {
        const actor = String(viewer?._id ?? '');
        if (!valid(actor) || viewer?.isVerified !== true) throw Object.assign(new Error('Sign in required'), { code: 'PRESENCE_AUTH_REQUIRED', status: 403 });
        const session = await connection.startSession(); let result;
        try {
            await session.withTransaction(async () => {
                const options = { session, maxTimeMS: 2000, timeoutMS: 2500 };
                const allowed = new Set(), publicContexts = contexts.filter(row => row.kind === 'd'), privateContexts = contexts.filter(row => row.kind === 'p');
                if (publicContexts.length) {
                    const rows = await connection.collection(DISCUSSION_COLLECTIONS.comments).aggregate([
                        { $match: { deleted: { $ne: true }, hidden: { $ne: true }, $or: publicContexts.map(row => ({ matchTPId: row.id, userId: { $in: row.userIds.map(object) } })) } },
                        { $group: { _id: { matchTPId: '$matchTPId', userId: '$userId' } } }, { $limit: 100 },
                    ], options).toArray();
                    for (const row of rows) if (publicContexts.some(context => context.id === row._id.matchTPId && context.userIds.includes(String(row._id.userId))))
                        allowed.add(String(row._id.userId));
                }
                if (privateContexts.length) {
                    const rows = await connection.collection(PRIVATE_MESSAGE_COLLECTIONS.pmConversations).find({
                        _id: { $in: privateContexts.map(row => object(row.id)) }, participants: object(actor), status: 'accepted',
                    }, { ...options, projection: { _id: 1, participants: 1, status: 1 } }).limit(privateContexts.length).toArray();
                    for (const row of rows) {
                        const members = row.participants?.map(String) ?? [], context = privateContexts.find(context => context.id === String(row._id));
                        if (!context || row.status !== 'accepted' || members.length !== 2 || !members.includes(actor)) continue;
                        for (const id of context.userIds) if (members.includes(id)) allowed.add(id);
                    }
                }
                if (!allowed.size) { result = { statuses: [] }; return; }
                const ids = [...allowed];
                const blocks = await connection.collection(PRIVATE_MESSAGE_COLLECTIONS.pmBlocks).find({ $or: [
                    { ownerId: object(actor), targetId: { $in: ids.map(object) } },
                    { targetId: object(actor), ownerId: { $in: ids.map(object) } },
                ] }, { ...options, projection: { ownerId: 1, targetId: 1 } }).limit(ids.length * 2).toArray();
                const blocked = new Set(blocks.map(row => String(row.ownerId) === actor ? String(row.targetId) : String(row.ownerId)));
                const users = await User.collection.find({ _id: { $in: ids.map(object) }, isVerified: true,
                    'accountClosure.requestedAt': { $exists: false }, 'presencePrivacy.showOnlineStatus': true,
                }, { ...options, projection: { _id: 1, isVerified: 1, accountClosure: 1, presencePrivacy: 1, email: 1, testAccount: 1 } }).limit(ids.length).toArray();
                result = { statuses: users.filter(user => allowed.has(String(user._id)) && !blocked.has(String(user._id))
                    && user.isVerified === true && !user.accountClosure?.requestedAt && user.presencePrivacy?.showOnlineStatus === true && eligible(user))
                    .map(user => ({ userId: String(user._id), online: hub.isPresent(String(user._id)) === true })) };
            }, { readConcern: { level: 'snapshot' }, maxCommitTimeMS: 2500 });
            return result;
        } finally { await session.endSession(); }
    };
}
