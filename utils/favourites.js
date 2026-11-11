export const FAVOURITES_LIMIT = 1000;
export const FAVOURITES_RESOLVE_LIMIT = 50;
export const favouriteId = id => Number.isSafeInteger(id) && id > 0;
export const favouritesError = (code, status = 503) => Object.assign(new Error(code), { code, status });

export function parseFavouriteId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) || !favouriteId(Number(value)))
        throw favouritesError('FAVOURITES_INVALID_ID', 400);
    return Number(value);
}
export function validateFavouriteBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw favouritesError('FAVOURITES_INVALID_BODY', 400);
}
export function validateFavouriteIds(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
        || !Array.isArray(body.ids) || body.ids.length > FAVOURITES_RESOLVE_LIMIT
        || !body.ids.every(favouriteId) || new Set(body.ids).size !== body.ids.length)
        throw favouritesError('FAVOURITES_INVALID_IDS', 400);
    return body.ids;
}

export function createFavouritesAvailability({ store, warn = message => console.warn(message) }) {
    let ready = false;
    return {
        available: () => ready,
        async initialize() {
            ready = false;
            try { await store.initialize(); ready = true; }
            catch (error) {
                warn(error.code === 11000
                    ? '[FAVOURITES] unavailable: duplicate owner/match pairs require manual review; no records changed.'
                    : '[FAVOURITES] unavailable: transaction/index initialization required; no records changed.');
            }
        },
    };
}

export function createFavourites({ store, resolver, available = () => true }) {
    function check(actor) {
        if (!actor?.user) throw favouritesError('FAVOURITES_AUTH_REQUIRED', 401);
        if (!available()) throw favouritesError('FAVOURITES_UNAVAILABLE');
    }
    return {
        async list(actor) {
            check(actor);
            const ids = await store.list(actor);
            return { ids, count: ids.length, limit: FAVOURITES_LIMIT };
        },
        async save(actor, id) {
            check(actor);
            if (!favouriteId(id)) throw favouritesError('FAVOURITES_INVALID_ID', 400);
            // Idempotent saves require no archive access. Do remote I/O OUTSIDE
            // the transaction, then recheck auth, ownership and cap on commit.
            const existing = await store.save(actor, id);
            if (existing) return existing;
            return store.save(actor, id, await resolver.exists(id));
        },
        async remove(actor, id) {
            check(actor);
            if (!favouriteId(id)) throw favouritesError('FAVOURITES_INVALID_ID', 400);
            return store.remove(actor, id);
        },
        async resolve(actor, body) {
            check(actor);
            actor.signal?.throwIfAborted();
            const ids = validateFavouriteIds(body);
            const owned = await store.owned(actor, ids);
            // Unowned IDs are omitted, never probed against canonical sources.
            actor.signal?.throwIfAborted();
            const matches = owned.length ? await resolver.resolve(owned, { signal: actor.signal }) : new Map();
            // A deletion, unsave or token revocation during archive I/O must not
            // return a formerly-owned row. The second check is transactional too.
            actor.signal?.throwIfAborted();
            const stillOwned = new Set(await store.owned(actor, owned));
            actor.signal?.throwIfAborted();
            return { items: ids.filter(id => stillOwned.has(id)).map(matchTPId => ({
                matchTPId, match: matches.get(matchTPId) ?? null,
            })) };
        },
    };
}
