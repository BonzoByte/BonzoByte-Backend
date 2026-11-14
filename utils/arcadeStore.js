import { arcadeError } from './arcadeCatalog.js';
import { ARCADE_COLLECTIONS, ARCADE_RULES, freshArcadeRating, rateArcade, showArcadeRating } from './arcade.js';
export function createArcadeStore({ connection, User, now = () => new Date(), names = ARCADE_COLLECTIONS }) {
    const profiles = () => connection.collection(names.arcadeProfiles);
    const seasons = () => connection.collection(names.arcadeSeasons);
    const sessions = () => connection.collection(names.arcadeSessions);
    const opts = session => ({ ...(session ? { session } : {}), maxTimeMS: 5000 });
    async function actorAllowed(actor, session, write = false) {
        if (!actor?.user || !Number.isInteger(actor.tokenVersion)) throw arcadeError('ARCADE_AUTH_REQUIRED', 401);
        const version = actor.tokenVersion === 0 ? { $or: [{ tokenVersion: 0 }, { tokenVersion: null }] } : { tokenVersion: actor.tokenVersion };
        const query = { _id: actor.user, ...version, 'accountClosure.requestedAt': { $exists: false } };
        if (!write) {
            if (!await User.collection.findOne(query, { ...opts(session), projection: { _id: 1 } })) throw arcadeError('ARCADE_AUTH_REQUIRED', 401);
        } else {
            if (!actor.operation?.id || actor.operation.tokenVersion !== actor.tokenVersion) throw arcadeError('ARCADE_AUTH_REQUIRED', 401);
            query.isVerified = true; query.accountOperations = { $elemMatch: { id: actor.operation.id, expiresAt: { $gt: now() } } };
            if (!(await User.collection.updateOne(query, { $inc: { 'accountOperations.$.arcadeWrites': 1 } }, opts(session))).matchedCount) throw arcadeError('ARCADE_AUTH_REQUIRED', 401);
        }
    }
    const transaction = fn => connection.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 3000, timeoutMS: 10000 });
    const rating = doc => doc?.rating ?? freshArcadeRating();
    async function settle(actor, row, won, result, session, digest = null) {
        const career = await profiles().findOne({ userId: actor.user }, opts(session));
        const season = await seasons().findOne({ userId: actor.user, month: row.month }, opts(session));
        const before = rating(career), seasonBefore = rating(season);
        const after = rateArcade(before, row.opponent.gameMu, won), seasonAfter = rateArcade(seasonBefore, row.opponent.gameMu, won);
        const saved = { ...result, trial: true, before: showArcadeRating(before), after: showArcadeRating(after),
            month: row.month, monthly: showArcadeRating(seasonAfter) };
        const at = now();
        await profiles().updateOne({ userId: actor.user }, { $set: { rating: after, updatedAt: at } }, { ...opts(session), upsert: true });
        await seasons().updateOne({ userId: actor.user, month: row.month }, { $set: { rating: seasonAfter, score: showArcadeRating(seasonAfter).score, updatedAt: at } }, { ...opts(session), upsert: true });
        const changed = await sessions().updateOne({ _id: row._id, userId: actor.user, status: 'active' }, { $set: {
            status: result.abandoned ? 'abandoned' : 'complete', result: saved, finishedAt: at, replaySha256: digest,
            purgeAt: new Date(+at + ARCADE_RULES.retentionDays * 86400000),
        } }, opts(session));
        if (!changed.matchedCount) throw arcadeError('ARCADE_ALREADY_FINISHED', 409);
        return saved;
    }
    return {
        async initialize() {
            const hello = await connection.db.admin().command({ hello: 1 });
            if (!hello.setName && hello.msg !== 'isdbgrid') throw Error('Arcade transactions required');
            await profiles().createIndex({ userId: 1 }, { unique: true });
            await seasons().createIndex({ userId: 1, month: 1 }, { unique: true });
            await seasons().createIndex({ month: 1, score: -1 });
            await sessions().createIndex({ userId: 1, requestId: 1 }, { unique: true });
            await sessions().createIndex({ userId: 1, day: 1 });
            await sessions().createIndex({ userId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
            await sessions().createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
        },
        async me(actor) {
            await actorAllowed(actor);
            const month = now().toISOString().slice(0,7);
            const profile = await profiles().findOne({ userId: actor.user }, opts());
            const seasonal = await seasons().findOne({ userId: actor.user, month }, opts());
            const rows = await sessions().find({ userId: actor.user, status: { $in: ['complete','abandoned'] } }, opts()).sort({ finishedAt: -1 }).limit(20).toArray();
            const active = await sessions().findOne({ userId: actor.user, status: 'active' }, opts());
            await actorAllowed(actor);
            return { trial: true, month, career: showArcadeRating(rating(profile)), monthly: showArcadeRating(rating(seasonal)),
                active: active ? { id: active._id, opponent: active.opponent.name, expired: active.expiresAt <= now() } : null,
                history: rows.map(r => ({ id: r._id, opponent: r.opponent, finishedAt: r.finishedAt, result: r.result })) };
        },
        async session(actor, id) { await actorAllowed(actor);
            return sessions().findOne({ _id: id, userId: actor.user, tokenVersion: actor.tokenVersion }, opts()); },
        async start(actor, entry) { return transaction(async session => {
            await actorAllowed(actor, session, true);
            const existing = await sessions().findOne({ userId: actor.user, requestId: entry.requestId }, opts(session));
            if (existing) {
                if (existing.status !== 'active' || existing.expiresAt <= now()) throw arcadeError('ARCADE_SESSION_EXPIRED', 409);
                if (existing.tokenVersion !== actor.tokenVersion || existing.opponent.id !== entry.opponent.id || existing.surface !== entry.surface || existing.engineVersion !== entry.engineVersion)
                    throw arcadeError('ARCADE_REQUEST_CHANGED', 409);
                return existing;
            }
            const count = await sessions().countDocuments({ userId: actor.user, day: entry.day }, opts(session));
            const against = await sessions().countDocuments({ userId: actor.user, day: entry.day, 'opponent.id': entry.opponent.id }, opts(session));
            if (count >= ARCADE_RULES.dailyLimit || against >= ARCADE_RULES.opponentDailyLimit) throw arcadeError('ARCADE_DAILY_LIMIT', 409);
            const unfinished = await sessions().findOne({ userId: actor.user, status: 'active' }, opts(session));
            if (unfinished) await settle(actor, unfinished, false, { winner: 1, score: null, abandoned: true }, session);
            const row = { ...entry, userId: actor.user, tokenVersion: actor.tokenVersion };
            await sessions().insertOne(row, opts(session));
            return row;
        }); },
        async finish(actor, id, digest, result) { return transaction(async session => {
            await actorAllowed(actor, session, true);
            const row = await sessions().findOne({ _id: id, userId: actor.user, tokenVersion: actor.tokenVersion }, opts(session));
            if (!row) throw arcadeError('ARCADE_SESSION_UNAVAILABLE', 404);
            if (row.status === 'complete' && row.replaySha256 === digest) return row.result;
            if (row.status !== 'active' || row.expiresAt <= now()) throw arcadeError('ARCADE_SESSION_EXPIRED', 409);
            return settle(actor, row, result.winner === 0, result, session, digest);
        }); },
        async leaderboard(month) {
            const rows = await seasons().aggregate([{ $match: { month } }, { $sort: { score: -1 } },
                { $lookup: { from: names.arcadeSessions, let: { user: '$userId' }, pipeline: [
                    { $match: { status: 'active', $expr: { $eq: ['$userId', '$$user'] } } }, { $limit: 1 }], as: 'active' } },
                { $match: { active: { $size: 0 } } },
                { $lookup: { from: User.collection.name, let: { user: '$userId' }, pipeline: [
                    { $match: { $expr: { $eq: ['$_id','$$user'] }, 'accountClosure.requestedAt': { $exists: false }, isVerified: true } },
                    { $project: { _id: 0, nickname: 1 } }], as: 'member' } },
                { $unwind: '$member' }, { $limit: 100 },
                { $project: { _id: 0, nickname: { $ifNull: ['$member.nickname','Player'] }, rating: 1, score: 1 } },
            ], { maxTimeMS: 5000, allowDiskUse: false }).toArray();
            return { items: rows.map((r,i) => ({ rank: i + 1, nickname: r.nickname, ...showArcadeRating(r.rating) })) };
        },
    };
}
