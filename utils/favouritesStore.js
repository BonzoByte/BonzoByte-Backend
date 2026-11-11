import { FAVOURITES_LIMIT, favouriteId, favouritesError } from './favourites.js';

export function createFavouritesStore({ connection, User, FavouriteMatch, now = () => new Date() }) {
    const collection = () => FavouriteMatch.collection;
    const options = session => ({ session, maxTimeMS: 5000 });
    const versionQuery = version => version === 0
        ? { $or: [{ tokenVersion: 0 }, { tokenVersion: null }] } : { tokenVersion: version };

    async function mutate(actor, fn) {
        if (!actor?.user || !actor.operation?.id || !Number.isInteger(actor.operation.tokenVersion)
            || actor.operation.tokenVersion < 0) throw favouritesError('FAVOURITES_AUTH_REQUIRED', 401);
        return connection.transaction(async session => {
            const at = now();
            const claimed = await User.collection.updateOne({ _id: actor.user,
                ...versionQuery(actor.operation.tokenVersion), 'accountClosure.requestedAt': { $exists: false },
                accountOperations: { $elemMatch: { id: actor.operation.id, expiresAt: { $gt: at } } },
            }, { $set: { 'accountOperations.$.expiresAt': new Date(+at + 120000) },
                // Forces same-account serialization even with a frozen clock.
                // A lease-only no-op would not reliably conflict with another add.
                $inc: { 'accountOperations.$.favouritesWrites': 1 },
            }, options(session));
            if (!claimed.matchedCount) throw favouritesError('FAVOURITES_AUTH_REQUIRED', 401);
            return fn(session, at);
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 3000, timeoutMS: 4000 });
    }

    async function list(actor) {
        const rows = await collection().find({ userId: actor.user }, {
            projection: { _id: 0, matchTPId: 1 }, maxTimeMS: 5000,
        }).sort({ matchTPId: 1 }).toArray();
        // Recheck after the read; do not return private data to a revoked session.
        if (!Number.isInteger(actor.tokenVersion) || actor.tokenVersion < 0
            || !await User.collection.findOne({ _id: actor.user, ...versionQuery(actor.tokenVersion),
                'accountClosure.requestedAt': { $exists: false } }, { projection: { _id: 1 }, maxTimeMS: 5000 }))
            throw favouritesError('FAVOURITES_AUTH_REQUIRED', 401);
        const ids = rows.map(row => row.matchTPId);
        if (!ids.every(favouriteId) || new Set(ids).size !== ids.length) throw favouritesError('FAVOURITES_UNAVAILABLE');
        // Deliberately no limit: legacy accounts above 1,000 remain fully readable.
        return ids;
    }
    async function save(actor, matchTPId, matchExists) {
        return mutate(actor, async (session, at) => {
            const query = { userId: actor.user, matchTPId };
            const existing = await collection().findOne(query, { ...options(session), projection: { _id: 1 } });
            const count = await collection().countDocuments({ userId: actor.user }, options(session));
            if (existing) return { matchTPId, saved: true, count };
            if (count >= FAVOURITES_LIMIT) throw favouritesError('FAVOURITES_LIMIT', 409);
            if (matchExists === undefined) return null;
            if (matchExists !== true) throw favouritesError('FAVOURITES_MATCH_NOT_FOUND', 404);
            await collection().insertOne({ ...query, createdAt: at, updatedAt: at }, options(session));
            return { matchTPId, saved: true, count: count + 1 };
        });
    }
    async function remove(actor, matchTPId) {
        return mutate(actor, async session => {
            await collection().deleteOne({ userId: actor.user, matchTPId }, options(session));
            return { matchTPId, saved: false,
                count: await collection().countDocuments({ userId: actor.user }, options(session)) };
        });
    }
    async function owned(actor, ids) {
        return mutate(actor, async session => {
            const rows = await collection().find({ userId: actor.user, matchTPId: { $in: ids } }, {
                ...options(session), projection: { _id: 0, matchTPId: 1 },
            }).toArray();
            return rows.map(row => row.matchTPId);
        });
    }
    async function initialize() {
        const hello = await connection.db.admin().command({ hello: 1 });
        if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Transactions required');
        // Unlike syncIndexes, createIndexes never drops/replaces existing indexes.
        // A duplicate pair fails initialization; NO migration/deletion is attempted.
        await FavouriteMatch.createIndexes({ maxTimeMS: 30000 });
    }
    return { initialize, list, save, remove, owned };
}
