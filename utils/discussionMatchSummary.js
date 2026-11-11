import { safePopularityLabel } from './popularityEntities.js';
import { publicFinalResult } from './publicFinalResult.js';

// Only public match identity and final result. Never return an unfiltered archive/detail object.
export function discussionMatchSummary(row, id) {
    if (!row || row.matchTPId !== id) return null;
    const first = safePopularityLabel(row.player1Name), second = safePopularityLabel(row.player2Name);
    if (!first || !second) return null;
    const summary = { matchTPId: id, player1Name: first, player2Name: second };
    if (Number.isSafeInteger(row.matchId) && row.matchId > 0) summary.matchId = row.matchId;
    for (const key of ['player1TPId', 'player2TPId', 'tournamentEventTPId']) {
        const raw = row[key], value = typeof raw === 'string' && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : raw;
        if (Number.isSafeInteger(value) && value > 0) summary[key] = value;
    }
    for (const key of ['dateTime', 'tournamentEventName', 'player1CountryISO2', 'player1CountryISO3', 'player1CountryFull',
        'player2CountryISO2', 'player2CountryISO3', 'player2CountryFull', 'player1Seed', 'player2Seed', 'player1Rank', 'player2Rank',
        'tournamentEventCountryISO3', 'tournamentTypeName', 'tournamentLevelName', 'surface', 'roundName']) {
        const value = row[key];
        const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
        if (key === 'tournamentLevelName' && typeof text === 'string' && /^[<>]\d{1,4}K$/.test(text)) { summary[key] = text; continue; }
        const label = safePopularityLabel(text);
        if (label) summary[key] = label;
    }
    const tournamentISO2 = typeof row.tournamentEventCountryISO2 === 'string' ? row.tournamentEventCountryISO2.trim().toUpperCase() : '';
    if (/^[A-Z]{2}$/.test(tournamentISO2) && !['XX', 'XW', 'WD', 'UN'].includes(tournamentISO2)) summary.tournamentEventCountryISO2 = tournamentISO2;
    const tournamentCountry = safePopularityLabel(row.tournamentEventCountryFull);
    if (tournamentCountry) summary.tournamentEventCountryFull = tournamentCountry;
    // Public daily-grid metadata only; no probability, odds, NN input or account fields.
    if (typeof row.tournamentStrengthMeanTS === 'number' && Number.isFinite(row.tournamentStrengthMeanTS))
        summary.tournamentStrengthMeanTS = row.tournamentStrengthMeanTS;
    if (['minute', 'second', 'date', 'unknown'].includes(row.sourceTimePrecision)) summary.sourceTimePrecision = row.sourceTimePrecision;
    const final = publicFinalResult(row);
    // Sets never bypass a pending/unverified result and never expose arbitrary detail text.
    const sets = typeof row.resultDetails === 'string' ? row.resultDetails.trim() : '';
    if (final.result && sets && sets.length <= 160 && !/[\p{Cc}\p{Cf}]/u.test(sets) && /^[0-9:()\[\]\s-]+$/.test(sets)) final.resultDetails = sets;
    return { ...summary, ...final };
}
