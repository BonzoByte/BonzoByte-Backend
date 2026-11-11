import { publicMatchOverview } from './publicMatchOverview.js';

export const validMatchLinkId = id => Number.isSafeInteger(id) && id > 0;
export const matchLinkError = (code, status = 503) => Object.assign(new Error(code), { code: `MATCH_LINK_${code}`, status });
export function parseMatchLinkId(raw) {
    if (typeof raw !== 'string' || !/^[1-9]\d{0,15}$/.test(raw) || !validMatchLinkId(Number(raw)))
        throw matchLinkError('INVALID_ID', 400);
    return Number(raw);
}

/** Maps identity only. It must never read or grant guarded match details. */
export function createMatchLinks({ resolveLegacy, locateCanonical }) {
    const project = (row, tp, id) => {
        if (!validMatchLinkId(tp) || !validMatchLinkId(id) || row?.matchTPId !== tp || row?.matchId !== id)
            throw matchLinkError('NOT_FOUND', 404);
        const match = publicMatchOverview(row, tp);
        if (!match || match.matchId !== id) throw matchLinkError('NOT_FOUND', 404);
        return { match };
    };
    return {
        async canonical(id, options = {}) {
            if (!validMatchLinkId(id)) throw matchLinkError('INVALID_ID', 400);
            const identity = await locateCanonical(id, options);
            if (!identity || identity.matchId !== id || !validMatchLinkId(identity.matchTPId)) throw matchLinkError('NOT_FOUND', 404);
            const row = await resolveLegacy(identity.matchTPId, options);
            return project(row, identity.matchTPId, id);
        },
        async legacy(tp, options = {}) {
            if (!validMatchLinkId(tp)) throw matchLinkError('INVALID_ID', 400);
            const row = await resolveLegacy(tp, options);
            if (!validMatchLinkId(row?.matchId)) throw matchLinkError('NOT_FOUND', 404);
            const identity = await locateCanonical(row.matchId, options);
            if (identity?.matchId !== row.matchId || identity?.matchTPId !== tp) throw matchLinkError('NOT_FOUND', 404);
            return project(row, tp, row.matchId);
        },
    };
}
