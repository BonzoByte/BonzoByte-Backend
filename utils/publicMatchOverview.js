import { discussionMatchSummary } from './discussionMatchSummary.js';

const text = value => typeof value === 'string' && value.trim().length <= 240 &&
    !/[<>\p{Cc}\p{Cf}]/u.test(value) ? value.trim() : null;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const oddsPair = (first, second) => finite(first) && first > 1 && finite(second) && second > 1;

/** A richer public daily-grid projection, never a guarded detail/archive spread. */
export function publicMatchOverview(row, tp) {
    const match = discussionMatchSummary(row, tp);
    if (!match) return null;
    for (const key of ['tournamentEventName', 'tournamentEventCountryISO2', 'tournamentEventCountryISO3',
        'tournamentEventCountryFull', 'tournamentTypeName', 'tournamentLevelName', 'surface', 'roundName']) {
        const value = text(row[key]); if (value) match[key] = value;
    }
    if (match.result) {
        const sets = text(row.resultDetails); if (sets) match.resultDetails = sets;
    }
    if (finite(row.tournamentStrengthMeanTS) && row.tournamentStrengthMeanTS >= 0)
        match.tournamentStrengthMeanTS = row.tournamentStrengthMeanTS;
    if (finite(row.prize) && row.prize > 0) match.prize = row.prize;
    match.marketOddsVerified = row.marketOddsVerified === true && oddsPair(row.player1Odds, row.player2Odds);
    if (match.marketOddsVerified) {
        match.player1Odds = row.player1Odds; match.player2Odds = row.player2Odds;
    } else {
        const first = row.legacyPlayer1Odds ?? (row.marketOddsVerified !== true ? row.player1Odds : null);
        const second = row.legacyPlayer2Odds ?? (row.marketOddsVerified !== true ? row.player2Odds : null);
        if (oddsPair(first, second)) { match.legacyPlayer1Odds = first; match.legacyPlayer2Odds = second; }
    }
    const allowed = row.predictionEligible === true && ['Validated', 'Incomplete'].includes(match.qualityStatus);
    const first = row.modelProbabilityPlayer1, second = row.modelProbabilityPlayer2;
    match.predictionEligible = allowed && finite(first) && finite(second) && first >= 0 && first <= 100 &&
        second >= 0 && second <= 100 && Math.abs(first + second - 100) < 0.01;
    if (match.predictionEligible) { match.modelProbabilityPlayer1 = first; match.modelProbabilityPlayer2 = second; }
    return match;
}
