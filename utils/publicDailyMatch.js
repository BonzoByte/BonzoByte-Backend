import { applyMatchQuality } from './matchQuality.js';

// Only the public daily-grid contract, never a spread of a source document.
// Keep this shared by /archives/daily and favourites/resolve.
const LITE_FIELDS = {
    l01: 'matchTPId', l02: 'dateTime', l03: 'isFinished', l04: 'tournamentEventName',
    l05: 'tournamentEventCountryISO2', l06: 'tournamentEventCountryISO3', l07: 'tournamentEventCountryFull',
    l08: 'tournamentEventSurfaceName', l09: 'tournamentLevelName', l10: 'tournamentTypeName',
    l11: 'tournamentStrengthMeanTS', l12: 'roundName', l13: 'player1TPId', l14: 'player1Name',
    l15: 'player1CountryISO2', l16: 'player1CountryISO3', l17: 'player1CountryFull', l18: 'player1Rank',
    l19: 'player1Seed', l20: 'player2TPId', l21: 'player2Name', l22: 'player2CountryISO2',
    l23: 'player2CountryISO3', l24: 'player2CountryFull', l25: 'player2Rank', l26: 'player2Seed',
    l27: 'result', l28: 'resultDetails', l29: 'player1Odds', l30: 'player2Odds',
    l32: 'tournamentEventTPId', l33: 'player1MaxOdds', l34: 'player2MaxOdds',
    l35: 'player1FairOdds', l36: 'player2FairOdds', l37: 'marketBookieCount',
    l38: 'qualityStatus', l39: 'qualityReason', l40: 'calculationEligible', l41: 'predictionEligible',
    l42: 'qualityPolicyVersion', l43: 'qualityAssessmentSha256', l44: 'matchId',
};
export const PUBLIC_DAILY_FIELDS = Object.freeze([...new Set([
    ...Object.values(LITE_FIELDS), 'sourceDate', 'sourceTimePrecision', 'dateSource',
    'surfaceId', 'surface', 'matchSurfaceName', 'tournamentEventCountryTPId', 'tournamentLevelId', 'tournamentTypeId',
    'player1CountryTPId', 'player2CountryTPId', 'marketOddsVerified', 'legacyPlayer1Odds', 'legacyPlayer2Odds',
    'winProbabilityPlayer1NN', 'winProbabilityPlayer2NN', 'modelProbabilityPlayer1', 'modelProbabilityPlayer2',
    'valueMarginPlayer1', 'valueMarginPlayer2', 'who2Bet', 'prize',
    'tournamentCleanName', 'surfaceDisplay', 'who2BetName', 'tournamentEventCountryISO2Display',
    'player1CountryISO2Display', 'player2CountryISO2Display', 'recoveryOddsCertifiedPrematch',
])]);
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
const string = value => typeof value === 'string' ? value : value == null ? '' : String(value);
const number = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const truth = value => value === true || value === 1 || value === '1' || value === 'true';
const displaySurface = value => /^(?:unknown|unk|n\/a|na|none|-|0)$/i.test(string(value).trim()) ? '' : string(value).trim();
const cleanTournament = value => string(value).replace(/\s*(?:\([^()]*\)\s*)+$/g, '')
    .replace(/\s*(?:[IVXLCDM]{1,4})\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
const playerLabel = (name, seed, country) => {
    const iso = string(country).toUpperCase().trim();
    return `${string(name)}${seed ? ` [${seed}]` : ''}${/^[A-Z]{3}$/.test(iso) && !['WLD'].includes(iso) ? ` (${iso})` : ''}`.trim();
};
const resultDetails = value => string(value).split(' ').filter(Boolean).map(token => {
    const m = token.match(/^(\d)(\d)(\(.+?\))?$/);
    return m ? `${m[1]}:${m[2]}${m[3] || ''}` : token;
}).join(' ');
const pair = (first, second) => {
    const a = number(first), b = number(second);
    if (a === null || b === null) return { left: '', right: '', text: '' };
    const fmt = n => '\u2007'.repeat(Math.max(0, 3 - n.toFixed(2).split('.')[0].length)) + n.toFixed(2);
    const left = fmt(a), right = fmt(b);
    return { left, right, text: `${left} - ${right}` };
};

export function projectPublicDailyMatch(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const source = applyMatchQuality(row), m = {};
    for (const key of PUBLIC_DAILY_FIELDS) if (Object.hasOwn(source, key) && scalar(source[key])) m[key] = source[key];
    for (const [key, name] of Object.entries(LITE_FIELDS))
        if (!Object.hasOwn(m, name) && Object.hasOwn(source, key) && scalar(source[key])) m[name] = source[key];
    m.isFinished = truth(m.isFinished);
    m.sourceDate = m.sourceDate ?? m.dateTime;
    m.sourceTimePrecision = ['minute', 'second', 'date', 'unknown'].includes(m.sourceTimePrecision)
        ? m.sourceTimePrecision : typeof m.dateTime === 'string' && m.dateTime.length === 10 ? 'date' : 'unknown';
    m.dateSource = m.dateSource ?? 'daily-archive';
    // Match the frontend's compact-grid probability and verified market contract.
    if (Object.hasOwn(source, 'l01')) {
        const rawProbability = number(source.l31);
        const knownScale = source.l45 == null || source.l45 === 'percent';
        const p1 = knownScale && rawProbability !== null && rawProbability >= 0 && rawProbability <= 100
            ? source.l45 === 'percent' ? rawProbability : rawProbability <= 1 ? rawProbability * 100 : rawProbability : null;
        m.modelProbabilityPlayer1 = p1;
        m.modelProbabilityPlayer2 = p1 === null ? null : 100 - p1;
        m.winProbabilityPlayer1NN = m.modelProbabilityPlayer1;
        m.winProbabilityPlayer2NN = m.modelProbabilityPlayer2;
        const o1 = number(m.player1Odds), o2 = number(m.player2Odds);
        const historicalRecoveryOdds = source.recoveryOddsCertifiedPrematch === false;
        const hasPair = o1 !== null && o1 > 1 && o2 !== null && o2 > 1;
        m.marketOddsVerified = hasPair && !historicalRecoveryOdds;
        m.player1Odds = m.marketOddsVerified ? o1 : null;
        m.player2Odds = m.marketOddsVerified ? o2 : null;
        if (!(number(m.marketBookieCount) > 0)) {
            for (const key of ['player1MaxOdds', 'player2MaxOdds', 'player1FairOdds', 'player2FairOdds', 'marketBookieCount']) m[key] = null;
        }
        m.legacyPlayer1Odds = historicalRecoveryOdds && hasPair ? o1 : null;
        m.legacyPlayer2Odds = historicalRecoveryOdds && hasPair ? o2 : null;
    }
    if (m.predictionEligible === false) {
        for (const key of ['modelProbabilityPlayer1', 'modelProbabilityPlayer2', 'winProbabilityPlayer1NN', 'winProbabilityPlayer2NN']) m[key] = null;
    }
    m.tournamentLevelName = string(m.tournamentLevelName).replace(/\\u003E/g, '>').replace(/\\u003C/g, '<');
    m.tournamentTypeName = string(m.tournamentTypeName).trim();
    const iso3 = string(m.tournamentEventCountryISO3).toUpperCase();
    const odds = pair(m.player1Odds ?? m.legacyPlayer1Odds, m.player2Odds ?? m.legacyPlayer2Odds);
    const probs = pair(m.modelProbabilityPlayer1 ?? m.winProbabilityPlayer1NN, m.modelProbabilityPlayer2 ?? m.winProbabilityPlayer2NN);
    const result = string(m.result);
    return {
        ...m,
        tournamentType: m.tournamentTypeName, tournamentLevel: m.tournamentLevelName,
        surface: displaySurface(m.matchSurfaceName || m.tournamentEventSurfaceName || m.surface),
        tournamentTitle: cleanTournament(m.tournamentEventName) + (iso3 && iso3 !== 'WLD' ? ` (${iso3})` : ''),
        player1Label: playerLabel(m.player1Name, m.player1Seed, m.player1CountryISO3),
        player2Label: playerLabel(m.player2Name, m.player2Seed, m.player2CountryISO3),
        resultText: /^\d{2}$/.test(result) ? `${result[0]}:${result[1]}` : result,
        resultDetailsText: resultDetails(m.resultDetails),
        oddsText: odds.text, oddsLeft: odds.left, oddsRight: odds.right,
        probabilityText: probs.text, probLeft: probs.left, probRight: probs.right,
    };
}
