import { competitionError, COMPETITION_RULES, settleCompetitionPick } from './competitionPolicy.js';
import { competitionProfileId, competitionProfileQuery } from './competitionPrivacy.js';
const maxMonthlyPicks = 31 * COMPETITION_RULES.dailyLimit;
// Null also matches picks written before withdrawal was introduced.
const active = { cancelledAt: null };

export function createCompetitionStore({ connection, User, environment, allowedSources = [], now = () => new Date() }) {
    if (!['development', 'production', 'development-demo', 'development-fixtures'].includes(environment)) throw new Error('Invalid competition environment');
    const picks = () => connection.collection('competitionpicks');
    const matches = () => connection.collection('competitionmatches_' + environment);
    const opts = session => ({ ...(session ? { session } : {}), maxTimeMS: 5000 });
    const version = v => v === 0 ? { $or: [{ tokenVersion: 0 }, { tokenVersion: null }] } : { tokenVersion: v };
    async function assertActor(actor, session, write = false) {
        if (!actor?.user || !Number.isInteger(actor.tokenVersion)) throw competitionError('COMPETITION_AUTH_REQUIRED', 401);
        const query = { _id: actor.user, ...version(actor.tokenVersion), 'accountClosure.requestedAt': { $exists: false } };
        if (!write) {
            if (!await User.collection.findOne(query, { ...opts(session), projection: { _id: 1 } }))
                throw competitionError('COMPETITION_AUTH_REQUIRED', 401);
            return;
        }
        if (!actor.operation?.id || actor.operation.tokenVersion !== actor.tokenVersion)
            throw competitionError('COMPETITION_AUTH_REQUIRED', 401);
        query.isVerified = true;
        query.accountOperations = { $elemMatch: { id: actor.operation.id, expiresAt: { $gt: now() } } };
        const claimed = await User.collection.updateOne(query, {
            $inc: { 'accountOperations.$.competitionWrites': 1 },
        }, opts(session));
        if (!claimed.matchedCount) throw competitionError('COMPETITION_AUTH_REQUIRED', 401);
    }
    async function initialize() {
        const hello = await connection.db.admin().command({ hello: 1 });
        if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Transactions required');
        await picks().createIndex({ environment: 1, userId: 1, matchTPId: 1 }, { unique: true, maxTimeMS: 30000 });
        await picks().createIndex({ environment: 1, userId: 1, submittedAt: 1 }, { maxTimeMS: 30000 });
        await picks().createIndex({ environment: 1, month: 1 }, { maxTimeMS: 30000 });
        await picks().createIndex({ environment: 1, matchTPId: 1, 'settlement.sourceRevision': 1 }, { maxTimeMS: 30000 });
        await matches().createIndex({ pendingSettlement: 1, _id: 1 }, { maxTimeMS: 30000 });
        await matches().createIndex({status:1, statusObservedAt:-1}, {maxTimeMS:30000});
    }
    const readMatch = (id, session) => matches().findOne({ _id: id }, opts(session));
    async function own(actor, month) {
        await assertActor(actor);
        const rows = await picks().find({ environment, userId: actor.user, month, ...active }, opts()).sort({ submittedAt: -1 }).limit(maxMonthlyPicks + 1).toArray();
        if (rows.length > maxMonthlyPicks) throw competitionError('COMPETITION_UNAVAILABLE');
        const today = now().toISOString().slice(0, 10);
        const used = await picks().countDocuments({ environment, userId: actor.user, day: today, ...active }, opts());
        await assertActor(actor);
        return { rows, remainingToday: Math.max(0, COMPETITION_RULES.dailyLimit - used) };
    }
    async function ownMatch(actor, id) {
        const row = await picks().findOne({ environment, userId: actor.user, matchTPId: id }, opts());
        await assertActor(actor); return row;
    }
    async function ownStats(actor) {
        await assertActor(actor);
        const [totals] = await picks().aggregate([
            { $match: { environment, userId: actor.user, ...active } },
            { $group: { _id: null,
                pending: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$settlement', null] }, null] }, 1, 0] } },
                won: { $sum: { $cond: [{ $eq: ['$settlement.status', 'won'] }, 1, 0] } },
                settled: { $sum: { $cond: [{ $in: ['$settlement.status', ['won', 'lost']] }, 1, 0] } },
            } },
        ], opts()).toArray();
        await assertActor(actor);
        return { pending: totals?.pending ?? 0, won: totals?.won ?? 0, settled: totals?.settled ?? 0 };
    }
    async function publicPicks(id, month) {
        const query = competitionProfileQuery(id, environment);
        const projection = { _id: 1, nickname: 1, 'competitionPrivacy.revision': 1 };
        const user = await User.collection.findOne(query, { ...opts(), projection });
        if (!user) throw competitionError('COMPETITION_PROFILE_UNAVAILABLE', 404);
        const at = now().toISOString();
        const rows = await picks().find({ environment, userId: user._id, month, ...active,
            'settlement.status': { $in: ['won', 'lost', 'void'] },
            'settlement.settledAt': { $type: 'string', $lte: at },
            'snapshot.startAt': { $type: 'string', $lte: at }, 'snapshot.lockAt': { $type: 'string', $lte: at },
        }, opts()).sort({ submittedAt: -1 }).limit(maxMonthlyPicks + 1).toArray();
        if (rows.length > maxMonthlyPicks) throw competitionError('COMPETITION_UNAVAILABLE');
        // Recheck after reading, so a concurrent closure or privacy change fails closed.
        const fresh = await User.collection.findOne({ ...query, _id: user._id,
            ...(['development-demo', 'development-fixtures'].includes(environment) ? {} : { 'competitionPrivacy.revision': user.competitionPrivacy?.revision ?? null }),
        }, { ...opts(), projection });
        if (!fresh) throw competitionError('COMPETITION_PROFILE_UNAVAILABLE', 404);
        return { nickname: fresh.nickname || 'Competitor', rows };
    }
    async function accept(actor, id, create) {
        if (['development-demo', 'development-fixtures'].includes(environment)) throw competitionError('COMPETITION_DEMO_READ_ONLY', 403);
        return connection.transaction(async session => {
            await assertActor(actor, session, true);
            const existing = await picks().findOne({ environment, userId: actor.user, matchTPId: id }, opts(session));
            const source = await readMatch(id, session);
            const at = now(), day = at.toISOString().slice(0, 10);
            const used = await picks().countDocuments({ environment, userId: actor.user, day, ...active }, opts(session));
            const current = existing?.cancelledAt ? null : existing;
            const row = create({ source, existing: current, used, at, epoch: existing?.withdrawalCount || 0 });
            if (current) return current;
            // Serializes acceptance against a concurrent source update / earlier start.
            const locked = await matches().updateOne({ _id: id, revision: source.revision },
                { $inc: { acceptedReads: 1 } }, opts(session));
            if (!locked.matchedCount) throw competitionError('COMPETITION_QUOTE_CHANGED', 409);
            const entry = { ...row, environment, userId: actor.user, matchTPId: id, day,
                month: day.slice(0, 7), submittedAt: at.toISOString(), settlement: null, settlementHistory: [] };
            if (existing) {
                await picks().updateOne({ _id: existing._id, cancelledAt: existing.cancelledAt },
                    { $set: { ...entry, cancelledAt: null } }, opts(session));
            } else await picks().insertOne(entry, opts(session));
            return entry;
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 3000, timeoutMS: 5000 });
    }
    async function withdraw(actor, id, submittedAt, check) {
        if (['development-demo', 'development-fixtures'].includes(environment)) throw competitionError('COMPETITION_DEMO_READ_ONLY', 403);
        return connection.transaction(async session => {
            await assertActor(actor, session, true);
            const target = { environment, userId: actor.user, matchTPId: id, submittedAt };
            const pick = await picks().findOne(target, opts(session));
            if (!pick) throw competitionError('COMPETITION_PICK_CHANGED', 409);
            if (pick.cancelledAt) return { withdrawn: true };
            const source = await readMatch(id, session), at = now();
            const deadline = check(pick, source, at);
            // Write the same match record as the publisher; a concurrent live/score
            // update forces a transaction retry and a fresh eligibility check.
            const locked = await matches().updateOne({ _id: id, revision: source.revision,
                $expr: { $lt: ['$$NOW', deadline] } }, { $inc: { withdrawalWrites: 1 } }, opts(session));
            if (!locked.matchedCount) throw competitionError('COMPETITION_LOCKED', 409);
            const cancelledAt = at.toISOString();
            const changed = await picks().updateOne({ ...target, ...active, settlement: null,
                $expr: { $lt: ['$$NOW', deadline] } }, {
                $set: { cancelledAt }, $inc: { withdrawalCount: 1 },
                $push: { withdrawalHistory: { $each: [{ submittedAt, cancelledAt, side: pick.side,
                    playerId: pick.snapshot.players[pick.side].id, odds: pick.snapshot.odds[pick.side],
                    lockAt: pick.snapshot.lockAt }], $slice: -32 } },
            }, opts(session));
            if (!changed.matchedCount) throw competitionError('COMPETITION_LOCKED', 409);
            return { withdrawn: true };
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 3000, timeoutMS: 5000 });
    }
    async function community(id, at) {
        // Aggregates only, and never before any accepted pick's immutable deadline.
        const rows = await picks().aggregate([
            { $match: { environment, matchTPId: id, ...active, 'snapshot.lockAt': { $lte: at.toISOString() } } },
            { $group: { _id: '$side', count: { $sum: 1 } } },
        ], { maxTimeMS: 5000 }).toArray();
        const counts = [0, 0]; for (const row of rows) if ([0, 1].includes(row._id)) counts[row._id] = row.count;
        return { counts, total: counts[0] + counts[1] };
    }
    async function leaderboard(month) {
        const valid = { $in: ['$settlement.status', ['won', 'lost']] };
        const rows = await picks().aggregate([
            { $match: { environment, month, ...active } },
            { $group: { _id: '$userId', submitted: { $sum: 1 },
                settled: { $sum: { $cond: [valid, 1, 0] } },
                won: { $sum: { $cond: [{ $eq: ['$settlement.status', 'won'] }, 1, 0] } },
                units: { $sum: { $cond: [valid, '$settlement.units', 0] } } } },
            { $lookup: { from: User.collection.collectionName || 'users', localField: '_id', foreignField: '_id',
                pipeline: [{ $match: { isVerified: true, 'accountClosure.requestedAt': { $exists: false } } },
                    { $project: { _id: 0, nickname: 1, competitionPrivacy: 1, testAccount: 1 } }], as: 'member' } },
            { $unwind: '$member' },
            { $project: { _id: 0, nickname: { $ifNull: ['$member.nickname', 'Competitor'] },
                _sharing: '$member', submitted: 1, settled: 1, won: 1, units: { $round: ['$units', 6] } } },
            { $sort: { units: -1, nickname: 1 } },
            { $facet: { qualified: [{ $match: { settled: { $gte: 30 } } }, { $limit: 100 }],
                provisional: [{ $match: { settled: { $lt: 30 } } }, { $limit: 100 }] } },
        ], { maxTimeMS: 5000, allowDiskUse: false }).toArray();
        const result = rows[0] || { qualified: [], provisional: [] };
        const sanitize = ({ _sharing, ...row }) => ({ ...row, picksProfileId: competitionProfileId(_sharing, environment) });
        return { qualified: result.qualified.map(sanitize), provisional: result.provisional.map(sanitize) };
    }
    async function reconcile() {
        if (['development-demo', 'development-fixtures'].includes(environment)) return { processed: 0 };
        // Source publication leaves a durable dirty flag. Restarts resume unfinished
        // batches; totals are derived from picks, never incremented a second time.
        let processed = 0;
        const sources = await matches().find({ pendingSettlement: true, source: { $in: allowedSources } }, opts()).sort({ _id: 1 }).limit(10).toArray();
        for (const source of sources) {
            const query = { environment, matchTPId: source.matchTPId, ...active,
                $or: [{ settlement: null }, { 'settlement.sourceRevision': { $lt: source.revision } }] };
            const batch = await picks().find(query, opts()).limit(100).toArray();
            for (const pick of batch) {
                const settlement = settleCompetitionPick(pick, source, now());
                if (!settlement) continue;
                await picks().updateOne({ _id: pick._id, submittedAt: pick.submittedAt, ...query }, {
                    $set: { settlement }, ...(pick.settlement ? { $push: { settlementHistory: pick.settlement } } : {}),
                }, opts());
                processed++;
            }
            if (!await picks().findOne(query, opts()))
                await matches().updateOne({ _id: source._id, revision: source.revision }, { $set: { pendingSettlement: false } }, opts());
        }
        return { processed };
    }
    const candidates = at => matches().find({status:'scheduled',rallyHeld:{$ne:true},$or:[
        {statusObservedAt:{$gte:new Date(+at-120000).toISOString()}},{scheduleCheckedAt:{$gte:new Date(+at-120000).toISOString()}}],
        source:{$in:allowedSources}, firstLockAt:{$gt:at.toISOString()}},opts()).limit(2000).toArray();
    return { initialize, candidates, readMatch, own, ownStats, ownMatch, publicPicks, accept, withdraw, community, leaderboard, reconcile };
}
