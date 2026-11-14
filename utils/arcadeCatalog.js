import { brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const decompress = promisify(brotliDecompress);
export const arcadeError = (code, status = 400) => Object.assign(new Error(code), { code, status });
const normalize = text => String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function createArcadeCatalog({ load, now = () => Date.now() }) {
    let cache, pending;
    async function catalogue() {
        if (cache && now() - cache.at < 300000) return cache;
        if (!pending) pending = (async () => {
            const { bytes, version, encoding } = await load();
            if (bytes.length > 16 * 1024 * 1024) throw arcadeError('ARCADE_CATALOG_UNAVAILABLE', 503);
            const json = JSON.parse((encoding === 'json' ? bytes : await decompress(bytes, { maxOutputLength: 80 * 1024 * 1024 })).toString('utf8').replace(/^\uFEFF/, ''));
            const source = Array.isArray(json) ? json : json.players ?? json.items;
            if (!Array.isArray(source) || source.length > 200000) throw arcadeError('ARCADE_CATALOG_UNAVAILABLE', 503);
            const rows = source.filter(p => Number.isSafeInteger(p.playerId ?? p.playerTPId) && (p.playerId ?? p.playerTPId) > 0 && typeof p.playerName === 'string')
                .map(p => ({ id: p.playerId ?? p.playerTPId, name: p.playerName.slice(0, 160), countryISO2: /^[A-Za-z]{2}$/.test(p.countryISO2 || '') ? p.countryISO2.toLowerCase() : null,
                    countryISO3: /^[A-Z]{3}$/.test(p.countryISO3 || '') ? p.countryISO3 : null,
                    ts: typeof p.currentTsMean === 'number' && Number.isFinite(p.currentTsMean) && p.currentTsMean >= -100 && p.currentTsMean <= 100 ? p.currentTsMean : null,
                    lastMatch: typeof p.dateOfLastMatch === 'string' ? p.dateOfLastMatch.slice(0, 10) : null,
                    search: normalize(p.playerName) }));
            rows.sort((a,b) => (b.ts ?? -1) - (a.ts ?? -1) || a.name.localeCompare(b.name));
            const byId = new Map(rows.map(p => [p.id, p]));
            if (byId.size !== rows.length || !rows.length) throw arcadeError('ARCADE_CATALOG_UNAVAILABLE', 503);
            cache = { at: now(), rows, byId, version: createHash('sha256').update(version).update(bytes).digest('hex') };
            return cache;
        })().finally(() => { pending = null; });
        return pending;
    }
    const publicRow = ({ search, ...p }) => p;
    return {
        async search(query = '') { const c = await catalogue(), q = normalize(query.trim());
            return { items: c.rows.filter(p => !q || p.search.includes(q)).slice(0, 12).map(publicRow), version: c.version }; },
        async get(id) { const c = await catalogue(), row = c.byId.get(id);
            if (!row || row.ts === null) throw arcadeError('ARCADE_OPPONENT_UNAVAILABLE', 409);
            return { ...publicRow(row), catalogVersion: c.version }; },
    };
}
