import { brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { favouriteId, favouritesError, FAVOURITES_RESOLVE_LIMIT } from './favourites.js';
import { projectPublicDailyMatch } from './publicDailyMatch.js';
import { popularitySourceDate } from './popularityEntities.js';

const decompress = promisify(brotliDecompress);
export const FAVOURITES_ARCHIVE_BOUNDS = Object.freeze({
    workers: 4, timeoutMs: 15000, readTimeoutMs: 5000, maxReads: 150,
    compressedTotal: 32 * 1024 * 1024, decodedTotal: 64 * 1024 * 1024,
    detailCompressed: 1024 * 1024, detailDecoded: 4 * 1024 * 1024,
    dailyCompressed: 4 * 1024 * 1024, dailyDecoded: 16 * 1024 * 1024,
});
const archiveDay = value => popularitySourceDate(value)?.sourceDate.slice(0, 10).replaceAll('-', '') ?? null;
const missing = error => error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;

export function createFavouritesResolver({ Match, readBuffer, locateDate = null, bounds = FAVOURITES_ARCHIVE_BOUNDS }) {
    function reader(signal) {
        let reads = 0, compressedTotal = 0, decodedTotal = 0;
        const controller = new AbortController();
        const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(bounds.timeoutMs), ...(signal ? [signal] : [])]);
        const days = new Map();
        async function read(kind, key) {
            deadline.throwIfAborted();
            if (++reads > bounds.maxReads) throw favouritesError('FAVOURITES_UNAVAILABLE');
            const maxBytes = kind === 'daily' ? bounds.dailyCompressed : bounds.detailCompressed;
            const maxOutputLength = kind === 'daily' ? bounds.dailyDecoded : bounds.detailDecoded;
            let bytes;
            try {
                bytes = await readBuffer(kind, key, {
                    maxBytes, signal: AbortSignal.any([deadline, AbortSignal.timeout(bounds.readTimeoutMs)]),
                });
            } catch (error) { if (missing(error)) return null; throw error; }
            compressedTotal += bytes.length;
            if (bytes.length > maxBytes || compressedTotal > bounds.compressedTotal) throw favouritesError('FAVOURITES_UNAVAILABLE');
            const decoded = await decompress(bytes, { maxOutputLength });
            decodedTotal += decoded.length;
            if (decodedTotal > bounds.decodedTotal) throw favouritesError('FAVOURITES_UNAVAILABLE');
            deadline.throwIfAborted();
            return JSON.parse(decoded.toString('utf8').replace(/^\uFEFF/, ''));
        }
        return {
            cancel: () => controller.abort(),
            detail: id => read('matches', String(id)),
            day(key) {
                if (!days.has(key)) days.set(key, read('daily', key).then(rows => {
                    if (rows !== null && !Array.isArray(rows)) throw favouritesError('FAVOURITES_UNAVAILABLE');
                    return rows;
                }));
                return days.get(key);
            },
        };
    }
    const find = (ids, projection) => Match.find({ _id: { $in: ids } }).select(projection)
        .maxTimeMS(3000).setOptions({ timeoutMS: 3000 }).lean();
    async function exists(id) {
        if (!favouriteId(id)) return false;
        if (locateDate) return Boolean((await resolve([id])).get(id));
        const rows = await find([id], '_id');
        if (rows.some(row => row._id === id)) return true;
        const detail = await reader().detail(id);
        return detail?.m001 === id;
    }
    async function resolve(ids, { signal } = {}) {
        if (!Array.isArray(ids) || ids.length > FAVOURITES_RESOLVE_LIMIT || !ids.every(favouriteId)
            || new Set(ids).size !== ids.length) throw favouritesError('FAVOURITES_INVALID_IDS', 400);
        const result = new Map();
        if (!ids.length) return result;
        // Dates only: no Mongo detail fields can enter the response.
        const mongo = locateDate ? new Map() : new Map((await find(ids, '_id dateTime')).map(row => [row._id, archiveDay(row.dateTime)]));
        const read = reader(signal); let next = 0;
        async function worker() {
            while (next < ids.length) {
                const id = ids[next++];
                const detail = locateDate ? null : await read.detail(id);
                // Archived details are only a locator. Neither content nor its
                // quality/probabilities/finished flag may become a public row.
                const detailDay = detail?.m001 === id ? archiveDay(detail.m003) : null;
                const locatedDay = locateDate ? archiveDay(await locateDate(id)) : null;
                const dates = [...new Set([locatedDay, detailDay, mongo.get(id)].filter(Boolean))];
                let match = null;
                for (const date of dates) {
                    const rows = await read.day(date);
                    const row = rows?.find(row => (row?.matchTPId ?? row?.l01) === id);
                    if (!row) continue;
                    // Never substitute the internal MatchId (l44), or accept
                    // conflicting identities/dates in a mixed legacy document.
                    if (row.matchTPId != null && row.l01 != null && row.matchTPId !== row.l01) continue;
                    const projected = projectPublicDailyMatch(row);
                    if (projected?.matchTPId !== id || archiveDay(projected.dateTime) !== date) continue;
                    match = projected; break;
                }
                result.set(id, match);
            }
        }
        try { await Promise.all(Array.from({ length: Math.min(bounds.workers, ids.length) }, worker)); }
        finally { read.cancel(); } // Stop sibling workers on failure or client cancellation.
        return result;
    }
    return { exists, resolve };
}
