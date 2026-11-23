import { ArchiveError } from './private-archive-reader/reader.mjs';

export const FIRST_RECENT_DAY = '2026-11-01';
const daily = /^daily\/(\d{4})(\d{2})(\d{2})\.br$/;
const detail = /^matches\/([1-9][0-9]*)\.br$/;
const missing = e => e instanceof ArchiveError && e.code === 'ARCHIVE_NOT_FOUND' && e.status === 404;
const historicalDay = path => {
    const m = daily.exec(path);
    return m && `${m[1]}-${m[2]}-${m[3]}` < FIRST_RECENT_DAY;
};

// Augment the existing recent head without changing its release identity.
// Historical reports, ratings, entity indexes and permission rules do not
// fall through. The only extra public content is old daily lists and details.
export function withHistoricalDailyArchive(recent, getHistory, onHistoryUnavailable = () => {}) {
    async function lookup(axis, id, options) {
        const found = await recent[axis](id, options);
        if (found) return found;
        const old = await (await getHistory())[axis](id, options);
        return old?.day < FIRST_RECENT_DAY ? old : null;
    }
    async function detailRead(id, options, load) {
        try { return await load(recent, id); }
        catch (e) { if (!missing(e)) throw e; }
        const old = await getHistory();
        const match = await old.locateMatchByTp(id, options);
        if (!match || !(match.day < FIRST_RECENT_DAY)) throw new ArchiveError('ARCHIVE_NOT_FOUND', 404);
        return load(old, id);
    }
    async function readPath(method, path, options) {
        if (historicalDay(path)) return (await getHistory())[method](path, options);
        const m = detail.exec(path);
        if (m) return detailRead(m[1], options, (r, id) => r[method](`matches/${id}.br`, options));
        return recent[method](path, options);
    }
    return Object.freeze({
        ...recent,
        async availableDates(options) {
            const live = await recent.availableDates(options);
            try {
                const history = await (await getHistory()).availableDates(options);
                return [...new Set([...history.filter(d => d < FIRST_RECENT_DAY), ...live])].sort();
            } catch (error) {
                if (options?.signal?.aborted) throw error;
                onHistoryUnavailable(error);
                return live;
            }
        },
        async read(kind, name, options) {
            if (kind === 'daily' && historicalDay(`daily/${name}.br`))
                return (await getHistory()).read(kind, name, options);
            if (kind === 'matches')
                return detailRead(name, options, (r, id) => r.read(kind, id, options));
            return recent.read(kind, name, options);
        },
        readJson: (path, opt) => readPath('readJson', path, opt),
        readRelative: (path, opt) => readPath('readRelative', path, opt),
        readVerified: (path, opt) => readPath('readVerified', path, opt),
        locateMatchByTp: (id, opt) => lookup('locateMatchByTp', id, opt),
        locateMatchById: (id, opt) => lookup('locateMatchById', id, opt),
        async locateDate(tp, opt) { return (await lookup('locateMatchByTp', tp, opt))?.day ?? null; },
    });
}
