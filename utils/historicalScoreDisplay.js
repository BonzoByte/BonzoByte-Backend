import { readFileSync } from 'node:fs';
import { brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(brotliCompress);
const HISTORICAL_LIMIT = '20261101';
const DATE = /^\d{8}$/;
const MATCH = /^matches\/([1-9]\d*)\.br$/;
const SCORE_POLICY = 'bonzobyte.historical-score-display.v1';
const DAILY_PATH = new URL('./historicalScoreDisplayData.json', import.meta.url);
const compactDate = value => typeof value === 'string' ? value.slice(0, 10).replaceAll('-', '') : '';
const empty = Object.freeze({ daily: (_date, rows) => rows, matchDetailReader: reader => reader });

// No writes, no new R2 objects, no changes to status, timestamps, entitlement,
// model probabilities, or the Rally archive head. Every display edit applies
// only if the immutable archive still carries the exact expected old facts.
export function createHistoricalScoreDisplay(data, onMismatch = () => {}) {
    if (data?.schema !== SCORE_POLICY || !Array.isArray(data.rows) || data.rows.length > 5000)
        throw new Error('Invalid historical score display manifest');
    const byDay = new Map(), byTp = new Map();
    for (const row of data.rows) {
        const [tp, id, event, left, right, date, before, after] = row;
        if (row.length !== 8 || [tp,id,event,left,right].some(x => !Number.isSafeInteger(x) || x < 1) ||
            left === right || byTp.has(String(tp)) || !DATE.test(date) || date >= HISTORICAL_LIMIT ||
            typeof before !== 'string' || !/^(?:21|2:1) \S+ \S+ \S+$/.test(before) ||
            after !== '3:0 '+before.slice(before.indexOf(' ') + 1))
            throw new Error('Invalid historical score display row');
        const patch = {tp, id, event, left, right, date, before, after};
        byTp.set(String(tp), patch);
        if (!byDay.has(date)) byDay.set(date, new Map());
        byDay.get(date).set(tp, patch);
    }
    const report = (kind, tp) => {
        try { onMismatch(kind, tp); } catch { /* Presentation must not break an archive response. */ }
    };
    function daily(date, rows) {
        const day = byDay.get(date);
        if (!day) return rows;
        return rows.map(r => {
            const m = day.get(r.l01);
            if (!m) return r;
            if (r.l44 !== m.id || r.l32 !== m.event || r.l13 !== m.left || r.l20 !== m.right ||
                compactDate(r.l02) !== date || r.l27 !== '21' || r.l28 !== m.before || r.l03 !== true ||
                r.l40 !== false || r.l41 !== false || r.l31 !== null) {
                report('daily', m.tp);
                return r;
            }
            return {...r, l27: '30', l28: m.after};
        });
    }
    function matchDetailReader(reader) {
        // Presentation-only facade for the existing details handler. Verify
        // original bytes first; this facade is not exposed to other readers.
        return Object.freeze({
            releaseId: reader.releaseId,
            locateMatchByTp: (...args) => reader.locateMatchByTp(...args),
            locateMatchById: (...args) => reader.locateMatchById(...args),
            async readVerified(logical, options) {
                const original = await reader.readVerified(logical, options);
                const m = byTp.get(MATCH.exec(logical)?.[1]);
                if (!m) return original;
                try {
                    const r = JSON.parse(original.decoded.toString('utf8'));
                    const q = r?.q;
                    if (r?.m001 !== m.tp || r.m002 !== m.event || r.m004 !== m.left || r.m005 !== m.right ||
                        q?.MatchId !== m.id || compactDate(r.m003) !== m.date || r.m010 !== '21' || r.m011 !== m.before ||
                        r.m656 !== true || r.m655 !== null || q.CalculationEligible !== false || q.PredictionEligible !== false) {
                        report('detail', m.tp);
                        return original;
                    }
                    const decoded = Buffer.from(JSON.stringify({...r, m010: '30', m011: m.after}));
                    const raw = await compress(decoded, {params: {[constants.BROTLI_PARAM_QUALITY]: 3}});
                    return {...original, raw, decoded};
                } catch {
                    report('detail', m.tp);
                    return original;
                }
            },
        });
    }
    return Object.freeze({daily, matchDetailReader});
}

export function loadHistoricalScoreDisplay(onMismatch) {
    try {
        const bytes = readFileSync(DAILY_PATH);
        if (bytes.length > 512 * 1024) throw new Error('Historical score manifest exceeds bound');
        const data = JSON.parse(bytes);
        if (data.rows?.length !== 3193) throw new Error('Incomplete historical score manifest');
        return createHistoricalScoreDisplay(data, onMismatch);
    } catch {
        console.warn('Historical score display manifest not loaded; serving unchanged archives.');
        return empty;
    }
}
