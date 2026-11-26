import { createHash } from 'node:crypto';

export const COMPETITION_RULES = Object.freeze({ version: 2, stake: 1, dailyLimit: 5,
    minimumSettled: 30, lockMinutes: 0, timeZone: 'UTC', money: false, prizes: true,
    rewardMembership: 'premium', rewardDays: 30, rewardReviewRequired: true, rewardAutomatic: false,
    changesAllowed: false, ranking: 'netUnits', monthBy: 'firstSubmission',
    statusMaxAgeSeconds: 120, oddsMaxAgeSeconds: 600 });
export const competitionError = (code, status = 503) => Object.assign(new Error(code), { code, status });
export const validCompetitionId = value => Number.isSafeInteger(value) && value > 0;
export function competitionId(value) {
    if (!/^[1-9]\d{0,15}$/.test(String(value)) || !validCompetitionId(Number(value)))
        throw competitionError('COMPETITION_INVALID_ID', 400);
    return Number(value);
}
export function competitionMonth(value, now = new Date()) {
    const month = value || now.toISOString().slice(0, 7);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || month > now.toISOString().slice(0, 7))
        throw competitionError('COMPETITION_INVALID_MONTH', 400);
    return month;
}
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
const fresh = (value, now, age) => date(value) && Date.parse(value) <= +now && +now - Date.parse(value) <= age;
export const MODEL_FAIR_ODDS = 'model-fair';
const MODEL_SOURCE_SCHEMA = 'bonzobyte.competition-model-source.v1';
export const fromPublishedSchedule = row => row?.schema===MODEL_SOURCE_SCHEMA && row.source==='rally-model-fair' &&
    row.oddsKind===MODEL_FAIR_ODDS && row.sourceEventId==='TP-schedule:'+row.matchTPId;
export const competitionLockAt = row => Math.min(Date.parse(row.startAt)-(fromPublishedSchedule(row)?0:300000),
    row.firstLockAt?Date.parse(row.firstLockAt):Infinity);
export const validUntil = row => Math.min(competitionLockAt(row),fromPublishedSchedule(row)
    ? Math.min(Date.parse(row.scheduleCheckedAt)+120000,Date.parse(row.statusObservedAt)+36*3600000)
    : Date.parse(row.statusObservedAt)+120000);

export function modelFairOdds(p1) {
    if (!Number.isFinite(p1) || p1 <= 0 || p1 >= 1) return null;
    const pair = [1 / p1, 1 / (1 - p1)];
    // Reject non-representable extremes; do not clamp or invent another quote.
    return pair.every(o => Number.isFinite(o) && o > 1 && o <= Number.MAX_SAFE_INTEGER) ? pair : null;
}

/** Trusted publisher contract, not a projection of historic Match/MatchActive rows.
 * Observation time means source observation, NEVER file mtime/import time. */
export function validateCompetitionObservation(input) {
    const modelFair = input?.schema === MODEL_SOURCE_SCHEMA && input.oddsKind === MODEL_FAIR_ODDS;
    if (!input || (!modelFair && input.schema !== 'bonzobyte.competition-source.v1')
        || !validCompetitionId(input.matchTPId) || !Number.isSafeInteger(input.revision) || input.revision < 1
        || !text(input.source) || !text(input.sourceEventId) || !text(input.tournament)
        || !date(input.startAt) || !date(input.statusObservedAt)
        || !['minute', 'second'].includes(input.timePrecision)
        || !['scheduled', 'live', 'finished', 'cancelled', 'walkover', 'retired'].includes(input.status)
        || !Array.isArray(input.players) || input.players.length !== 2
        || !input.players.every(p => validCompetitionId(p.id) && text(p.name))
        || input.players[0].id === input.players[1].id)
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    if (input.model != null && (!text(input.model.version) || !date(input.model.issuedAt)
        || !Number.isFinite(input.model.p1) || input.model.p1 < 0 || input.model.p1 > 1))
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    const fair = modelFair ? modelFairOdds(input.model?.p1) : null;
    if (modelFair) {
        if (!fair || (!fromPublishedSchedule(input) && Date.parse(input.model.issuedAt) > Date.parse(input.statusObservedAt))
            || (input.odds != null && (!Array.isArray(input.odds) || input.odds.length !== 2 || fair.some((o,i) => o !== input.odds[i])))
            || (input.bookmakers != null && input.bookmakers !== 0)
            || (input.oddsObservedAt != null && input.oddsObservedAt !== input.model.issuedAt))
            throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    } else if (!date(input.oddsObservedAt) || !Array.isArray(input.odds) || input.odds.length !== 2
        || !input.odds.every(o => Number.isFinite(o) && o > 1 && o <= 1000)
        || input.oddsKind !== 'median' || !Number.isSafeInteger(input.bookmakers) || input.bookmakers < 1) {
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    }
    if (input.status === 'finished' && (input.resultVerified !== true || ![0, 1].includes(input.winner)
        || Date.parse(input.statusObservedAt) < Date.parse(input.startAt)))
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    if (['cancelled', 'walkover', 'retired'].includes(input.status) && input.resultVerified !== true)
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    // Allowlist deliberately discards any personal/provider payload or arbitrary keys.
    return { schema: input.schema, matchTPId: input.matchTPId, revision: input.revision,
        source: input.source, sourceEventId: input.sourceEventId, tournament: input.tournament,
        startAt: input.startAt, timePrecision: input.timePrecision, status: input.status,
        statusObservedAt: input.statusObservedAt, oddsObservedAt: modelFair ? input.model.issuedAt : input.oddsObservedAt,
        players: input.players.map(({ id, name }) => ({ id, name })), odds: modelFair ? fair : [...input.odds],
        oddsKind: modelFair ? MODEL_FAIR_ODDS : 'median', bookmakers: modelFair ? 0 : input.bookmakers,
        model: input.model ? { version: input.model.version, issuedAt: input.model.issuedAt, p1: input.model.p1 } : null,
        winner: input.status === 'finished' ? input.winner : null, resultVerified: input.resultVerified === true };
}
export function competitionEligibility(source, now = new Date(), allowedSources = [], { modelFairOnly = false } = {}) {
    if (!source || source.rallyHeld === true) return 'sourceUnavailable';
    let row;
    try { row = validateCompetitionObservation(source); } catch { return 'sourceUnavailable'; }
    if (!allowedSources.includes(row.source) || (modelFairOnly && row.oddsKind !== MODEL_FAIR_ODDS)) return 'sourceUnavailable';
    if (row.status !== 'scheduled') return 'locked';
    const lockAt = competitionLockAt(source);
    if (!Number.isFinite(lockAt) || +now >= lockAt) return 'locked';
    if (fromPublishedSchedule(row)) {
        if (!fresh(source.scheduleCheckedAt,now,120000)||!fresh(row.statusObservedAt,now,36*3600000)||
            !date(row.model.issuedAt)||Date.parse(row.model.issuedAt)>+now) return 'stale';
    } else if (!fresh(row.statusObservedAt, now, 120000)) return 'stale';
    if (row.oddsKind === MODEL_FAIR_ODDS) {
        if (Date.parse(row.model.issuedAt) >= lockAt) return 'locked';
    } else if (!fresh(row.oddsObservedAt, now, 600000)) return 'stale';
    return null;
}
export function competitionSnapshot(source) {
    const row = validateCompetitionObservation(source);
    // No retroactive model output can be used as a benchmark.
    if (row.model && !fromPublishedSchedule(row) && Date.parse(row.model.issuedAt) > Date.parse(row.statusObservedAt)) row.model = null;
    return { ...row, lockAt: new Date(competitionLockAt(source)).toISOString() };
}
export const snapshotHash = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const rounded = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
export function settleCompetitionPick(pick, result, now = new Date()) {
    const row = validateCompetitionObservation(result);
    if (row.matchTPId !== pick.matchTPId || row.players.some((p, i) => p.id !== pick.snapshot.players[i].id)
        || !row.resultVerified || !date(row.statusObservedAt) || Date.parse(row.statusObservedAt) > +now
        || Date.parse(row.statusObservedAt) < Date.parse(pick.submittedAt)) return null;
    const voided = ['cancelled', 'walkover', 'retired'].includes(row.status);
    if (!voided && row.status !== 'finished') return null;
    const pnl = side => side === null ? null : voided ? 0 : side === row.winner ? rounded(pick.snapshot.odds[side] - 1) : -1;
    const probability = pick.snapshot.model?.p1;
    const modelSide = probability == null || probability === 0.5 ? null : probability > 0.5 ? 0 : 1;
    const marketSide = pick.snapshot.oddsKind === MODEL_FAIR_ODDS || pick.snapshot.odds[0] === pick.snapshot.odds[1]
        ? null : pick.snapshot.odds[0] < pick.snapshot.odds[1] ? 0 : 1;
    return { sourceRevision: row.revision, settledAt: now.toISOString(),
        status: voided ? 'void' : pick.side === row.winner ? 'won' : 'lost', reason: row.status,
        units: pnl(pick.side), modelUnits: pnl(modelSide), marketUnits: pnl(marketSide),
        winner: row.winner, resultObservedAt: row.statusObservedAt };
}
export function competitionSummary(picks) {
    const completed = picks.filter(p => ['won', 'lost'].includes(p.settlement?.status));
    const won = completed.filter(p => p.settlement.status === 'won').length;
    const units = rounded(completed.reduce((sum, p) => sum + p.settlement.units, 0));
    // Like-for-like subset only: skip missing model predictions and ties on either side.
    const comparable = completed.filter(p => p.settlement.modelUnits != null && p.settlement.marketUnits != null);
    return { submitted: picks.length, pending: picks.filter(p => !p.settlement).length,
        voided: picks.filter(p => p.settlement?.status === 'void').length, settled: completed.length, won,
        units, hitRate: completed.length ? 100 * won / completed.length : null,
        roi: completed.length ? 100 * units / completed.length : null, qualified: completed.length >= 30,
        comparison: { count: comparable.length, userUnits: rounded(comparable.reduce((s, p) => s + p.settlement.units, 0)),
            modelUnits: rounded(comparable.reduce((s, p) => s + p.settlement.modelUnits, 0)),
            marketUnits: rounded(comparable.reduce((s, p) => s + p.settlement.marketUnits, 0)) } };
}
