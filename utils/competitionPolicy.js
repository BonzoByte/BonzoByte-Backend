import { createHash } from 'node:crypto';

export const COMPETITION_RULES = Object.freeze({ version: 1, stake: 1, dailyLimit: 5,
    minimumSettled: 30, lockMinutes: 5, timeZone: 'UTC', money: false, prizes: false,
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

/** Trusted publisher contract, not a projection of historic Match/MatchActive rows.
 * Observation time means source observation, NEVER file mtime/import time. */
export function validateCompetitionObservation(input) {
    if (!input || input.schema !== 'bonzobyte.competition-source.v1'
        || !validCompetitionId(input.matchTPId) || !Number.isSafeInteger(input.revision) || input.revision < 1
        || !text(input.source) || !text(input.sourceEventId) || !text(input.tournament)
        || !date(input.startAt) || !date(input.statusObservedAt) || !date(input.oddsObservedAt)
        || !['minute', 'second'].includes(input.timePrecision)
        || !['scheduled', 'live', 'finished', 'cancelled', 'walkover', 'retired'].includes(input.status)
        || !Array.isArray(input.players) || input.players.length !== 2
        || !input.players.every(p => validCompetitionId(p.id) && text(p.name))
        || input.players[0].id === input.players[1].id
        || !Array.isArray(input.odds) || input.odds.length !== 2
        || !input.odds.every(o => Number.isFinite(o) && o > 1 && o <= 1000)
        || input.oddsKind !== 'median' || !Number.isSafeInteger(input.bookmakers) || input.bookmakers < 1)
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    if (input.model != null && (!text(input.model.version) || !date(input.model.issuedAt)
        || !Number.isFinite(input.model.p1) || input.model.p1 < 0 || input.model.p1 > 1))
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    if (input.status === 'finished' && (input.resultVerified !== true || ![0, 1].includes(input.winner)
        || Date.parse(input.statusObservedAt) < Date.parse(input.startAt)))
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    if (['cancelled', 'walkover', 'retired'].includes(input.status) && input.resultVerified !== true)
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    // Allowlist deliberately discards any personal/provider payload or arbitrary keys.
    return { schema: input.schema, matchTPId: input.matchTPId, revision: input.revision,
        source: input.source, sourceEventId: input.sourceEventId, tournament: input.tournament,
        startAt: input.startAt, timePrecision: input.timePrecision, status: input.status,
        statusObservedAt: input.statusObservedAt, oddsObservedAt: input.oddsObservedAt,
        players: input.players.map(({ id, name }) => ({ id, name })), odds: [...input.odds],
        oddsKind: 'median', bookmakers: input.bookmakers,
        model: input.model ? { version: input.model.version, issuedAt: input.model.issuedAt, p1: input.model.p1 } : null,
        winner: input.status === 'finished' ? input.winner : null, resultVerified: input.resultVerified === true };
}
export function competitionEligibility(source, now = new Date(), allowedSources = []) {
    if (!source) return 'sourceUnavailable';
    let row;
    try { row = validateCompetitionObservation(source); } catch { return 'sourceUnavailable'; }
    if (!allowedSources.includes(row.source)) return 'sourceUnavailable';
    if (row.status !== 'scheduled') return 'locked';
    const lockAt = Math.min(Date.parse(row.startAt) - 300000, source.firstLockAt ? +new Date(source.firstLockAt) : Infinity);
    if (!Number.isFinite(lockAt) || +now >= lockAt) return 'locked';
    if (!fresh(row.statusObservedAt, now, 120000) || !fresh(row.oddsObservedAt, now, 600000)) return 'stale';
    return null;
}
export function competitionSnapshot(source) {
    const row = validateCompetitionObservation(source);
    // No retroactive model output can be used as a benchmark.
    if (row.model && Date.parse(row.model.issuedAt) > Date.parse(row.statusObservedAt)) row.model = null;
    return { ...row, lockAt: new Date(Math.min(Date.parse(row.startAt) - 300000,
        source.firstLockAt ? +new Date(source.firstLockAt) : Infinity)).toISOString() };
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
    const marketSide = pick.snapshot.odds[0] === pick.snapshot.odds[1] ? null : pick.snapshot.odds[0] < pick.snapshot.odds[1] ? 0 : 1;
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
