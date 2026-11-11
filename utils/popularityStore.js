import { DAY_MS, DEDUPE_MAX_RETENTION_MS, HALF_LIFE_DAYS, WINDOW_DAYS, RANKING_CANDIDATE_LIMIT, utcDay, popularityError } from './popularity.js';

export function popularityRankingPipeline(kind, day) {
    return [
        { $match: { kind, day: { $gte: new Date(+day - (WINDOW_DAYS - 1) * DAY_MS), $lte: day }, count: { $gt: 0 } } },
        { $group: { _id: '$entityId', score: { $sum: { $multiply: ['$count',
            { $pow: [0.5, { $divide: [{ $subtract: [day, '$day'] }, HALF_LIFE_DAYS * DAY_MS] }] }] } } } },
        { $sort: { score: -1, _id: 1 } },
        { $limit: RANKING_CANDIDATE_LIMIT },
        { $project: { _id: 0, entityId: '$_id' } },
    ];
}

export function createPopularityStore({ connection, User, config, now = () => new Date() }) {
    const daily = () => connection.collection(config.dailyCollection);
    const dedupe = () => connection.collection(config.dedupeCollection);
    const options = session => ({ session, maxTimeMS: 5000 });

    async function initialize() {
        // Provision indexes even when counting is off, so withdrawal still works.
        await daily().createIndex({ kind: 1, entityId: 1, day: 1 }, { unique: true });
        await daily().createIndex({ kind: 1, day: 1 });
        await daily().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await dedupe().createIndex({ user: 1, day: 1, kind: 1, entityId: 1 }, { unique: true });
        await dedupe().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }

    async function mutate(actor, fn) {
        if (!actor?.user || !actor.operation?.id || !Number.isInteger(actor.operation.tokenVersion)
            || actor.operation.tokenVersion < 0) throw popularityError('POPULARITY_AUTH_REQUIRED', 401);
        // Retry duplicate-key upsert races across DIFFERENT users. Same-user
        // requests serialize on the account document; driver retries write conflicts.
        for (let attempt = 0; ; attempt++) {
            try {
                return await connection.transaction(async session => {
                    const at = now(), tokenVersion = actor.operation.tokenVersion;
                    const version = tokenVersion === 0 ? { $or: [{ tokenVersion: 0 }, { tokenVersion: null }] } : { tokenVersion };
                    const claimed = await User.collection.updateOne({ _id: actor.user, ...version,
                        'accountClosure.requestedAt': { $exists: false },
                        accountOperations: { $elemMatch: { id: actor.operation.id, expiresAt: { $gt: at } } } },
                    { $set: { 'accountOperations.$.expiresAt': new Date(+at + 120000) },
                        // Always modify the account, even when two checks share
                        // the same clock millisecond. A no-op lease renewal alone
                        // does not provide a reliable transaction write conflict.
                        $inc: { 'accountOperations.$.popularityWrites': 1 } }, options(session));
                    if (!claimed.matchedCount) throw popularityError('POPULARITY_AUTH_REQUIRED', 401);
                    return fn(session, at);
                }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000 });
            } catch (error) {
                if (error.code !== 11000 || attempt >= 2) throw error;
            }
        }
    }

    async function record(actor, { kind, entityId, at }) {
        const day = utcDay(at), countUntil = new Date(+day + DAY_MS);
        const expiresAt = new Date(+day + DEDUPE_MAX_RETENTION_MS);
        await mutate(actor, async (session, current) => {
            // Never backfill delayed requests into a previous UTC day.
            if (current >= countUntil || current < day) return;
            if (await dedupe().findOne({ user: actor.user, kind: 'withdrawn', day: { $gte: day } }, options(session))) return;
            const claim = await dedupe().updateOne({ user: actor.user, day, kind, entityId },
                { $setOnInsert: { expiresAt } }, { ...options(session), upsert: true });
            if (!claim.upsertedCount) return;
            await daily().updateOne({ kind, entityId, day },
                { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(+day + WINDOW_DAYS * DAY_MS) } },
                { ...options(session), upsert: true });
        });
    }

    async function withdraw(actor) {
        await mutate(actor, async (session, at) => {
            const day = utcDay(at);
            await dedupe().deleteMany({ user: actor.user }, options(session));
            // Entity-free, same-day suppression prevents an in-flight opt-in or
            // repeated withdrawal/re-opt-in from recreating history/double counts.
            await dedupe().insertOne({ user: actor.user, day, kind: 'withdrawn', entityId: 0,
                expiresAt: new Date(+day + DEDUPE_MAX_RETENTION_MS) }, options(session));
        });
    }

    async function* ranked(kind, day) {
        const cursor = daily().aggregate(popularityRankingPipeline(kind, day), { maxTimeMS: 5000, batchSize: 25 });
        try { for await (const row of cursor) yield row; }
        finally { await cursor.close(); }
    }
    return { initialize, record, withdraw, ranked };
}
