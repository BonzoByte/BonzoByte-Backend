import { readFileSync } from 'node:fs';

const END = '20261101';
const DATE = /^\d{8}$/;
const SCHEMA = 'bonzobyte.unplayed-historical-daily.v1';
const SOURCE = new URL('./historicalUnplayedDailyData.json', import.meta.url);
const dayOf = row => typeof row?.l02 === 'string' ? row.l02.slice(0,10).replaceAll('-','') : '';
const positive = value => Number.isSafeInteger(value) && value > 0;

// Filter only the exact independently reviewed grid row. Do not change
// archives, detail links, favourites, calendar dates, or any model output.
export function createHistoricalUnplayedDaily(data) {
    if (data?.schema !== SCHEMA || !Array.isArray(data.rows) || !data.rows.length || data.rows.length > 8500)
        throw new Error('Invalid unplayed historical manifest');
    const allowlist = new Map(), removed = new Set();
    for (const entry of data.rows) {
        if (!Array.isArray(entry) || entry.length !== 13) throw new Error('Invalid excluded row');
        const [day,id,tp,event,a,b,round,playedId,playedTp,c,d,result,score] = entry;
        if (typeof day !== 'string' || !DATE.test(day) || day >= END || ![id,tp,event,a,b,playedId,playedTp,c,d].every(positive)
            || id === playedId || tp === playedTp || a === b || c === d || [a,b].filter(p => p === c || p === d).length !== 1
            || removed.has(id) || typeof round !== 'string' || !round || !/^(?:20|21|30|31|32)$/.test(result)
            || typeof score !== 'string' || !score || score.length > 140) throw new Error('Unbound historical row');
        removed.add(id);
        if (!allowlist.has(day)) allowlist.set(day,new Map());
        allowlist.get(day).set(id,{day,id,tp,event,a,b,round,playedId,playedTp,c,d,result,score});
    }
    if (data.rows.some(r => removed.has(r[7]))) throw new Error('An alternate result is itself marked as unplayed');
    return function filterHistoricalUnplayedDaily(day, rows) {
        const proofs = allowlist.get(day);
        if (!proofs) return rows;
        const byId = new Map();
        for (const r of rows) {
            if (byId.has(r.l44)) return rows;
            byId.set(r.l44,r);
        }
        return rows.filter(r => {
            const p = proofs.get(r.l44);
            if (!p) return true;
            const s = byId.get(p.playedId);
            return !(r.l01 === p.tp && r.l32 === p.event && r.l13 === p.a && r.l20 === p.b && dayOf(r) === day
                && r.l12 === p.round && r.l03 === false && r.l27 === null && r.l28 === null && r.l31 === null
                && r.l40 === false && r.l41 === false && s?.l01 === p.playedTp && s.l32 === p.event
                && s.l13 === p.c && s.l20 === p.d && dayOf(s) === day && s.l12 === p.round && s.l03 === true
                && s.l40 === true && s.l38 === 'Validated' && s.l27 === p.result && s.l28 === p.score);
        });
    };
}

export function loadHistoricalUnplayedDaily() {
    try {
        const bytes=readFileSync(SOURCE);
        if (bytes.length > 1024 * 1024) throw new Error('Historical exclusion manifest exceeds bound');
        return createHistoricalUnplayedDaily(JSON.parse(bytes));
    } catch {
        console.warn('Historical grid exclusion manifest unavailable; leaving archive rows unchanged.');
        return (_day,rows) => rows;
    }
}
