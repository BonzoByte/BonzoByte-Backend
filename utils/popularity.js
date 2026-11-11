export const POPULARITY_POLICY = 'popularity-2026-10-04.1';
export const DAY_MS = 86400000;
export const WINDOW_DAYS = 28;
export const HALF_LIFE_DAYS = 7;
export const CACHE_MS = 300000;
export const DEDUPE_MAX_RETENTION_MS = 2 * DAY_MS;
export const RANKING_CANDIDATE_LIMIT = 100;
export const utcDay = at => new Date(Math.floor(+at / DAY_MS) * DAY_MS);
export const canonicalTPId = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const popularityError = (code, status) => Object.assign(new Error(code), { code, status });

export function validatePopularityView(body) {
    if (!body || body.consent !== true || body.policy !== POPULARITY_POLICY)
        throw popularityError('POPULARITY_CONSENT_REQUIRED', 400);
    if (!['match', 'player'].includes(body.kind) || !canonicalTPId(body.entityId)
        || Object.keys(body).some(key => !['kind', 'entityId', 'consent', 'policy'].includes(key)))
        throw popularityError('POPULARITY_INVALID_REQUEST', 400);
    return { kind: body.kind, entityId: body.entityId };
}

export function popularityMetadata(environment, available, at) {
    const day = utcDay(at);
    return { environment, available, policy: POPULARITY_POLICY, generatedAt: at.toISOString(),
        windowDays: WINDOW_DAYS, halfLifeDays: HALF_LIFE_DAYS, cacheSeconds: CACHE_MS / 1000,
        windowStart: new Date(+day - (WINDOW_DAYS - 1) * DAY_MS).toISOString(),
        windowEnd: new Date(+day + DAY_MS).toISOString() };
}

export function createPopularity({ store, resolveEntity, environment, available = () => true,
    withdrawalAvailable = available, now = () => new Date() }) {
    let cached, pending;
    async function rankings() {
        const at = now();
        if (!available()) return { ...popularityMetadata(environment, false, at), matches: [], players: [] };
        // Midnight changes both the UTC buckets and the window, regardless of cache age.
        if (cached && +at < cached.expiresAt && +utcDay(at) === cached.day) return cached.value;
        if (pending?.day === +utcDay(at)) return pending.promise;
        const generation = { day: +utcDay(at) };
        generation.promise = (async () => {
            const lists = await Promise.all(['match', 'player'].map(async kind => {
                const result = [];
                let scanned = 0;
                for await (const candidate of store.ranked(kind, utcDay(at))) {
                    scanned++;
                    if (canonicalTPId(candidate.entityId)) {
                        const entity = await resolveEntity(kind, candidate.entityId);
                        if (entity) result.push(entity);
                    }
                    if (result.length === 10 || scanned >= RANKING_CANDIDATE_LIMIT) break;
                }
                return result;
            }));
            const value = { ...popularityMetadata(environment, true, at), matches: lists[0], players: lists[1] };
            if (!cached || cached.day <= generation.day)
                cached = { value, expiresAt: +at + CACHE_MS, day: generation.day };
            return value;
        })();
        pending = generation;
        try { return await generation.promise; } finally { if (pending === generation) pending = undefined; }
    }
    async function view(actor, body) {
        const { kind, entityId } = validatePopularityView(body);
        if (!available()) throw popularityError('POPULARITY_UNAVAILABLE', 503);
        const at = now();
        if (!await resolveEntity(kind, entityId)) throw popularityError('POPULARITY_ENTITY_NOT_FOUND', 404);
        await store.record(actor, { kind, entityId, at });
        // No counted/duplicate flag or user history leaves this service.
        return { accepted: true };
    }
    async function withdraw(actor) {
        if (!withdrawalAvailable()) throw popularityError('POPULARITY_UNAVAILABLE', 503);
        await store.withdraw(actor);
    }
    return { rankings, view, withdraw };
}
