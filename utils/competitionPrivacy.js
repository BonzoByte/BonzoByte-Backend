import { randomUUID } from 'node:crypto';
import { competitionError } from './competitionPolicy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEMO = /^demo-user-(0[1-9]|1[0-9])$/;
export const competitionPrivacyDto = user => ({ shareSettledPicks: user?.competitionPrivacy?.shareSettledPicks === true });

export function updateCompetitionPrivacy(user, value) {
    if (value === undefined) return;
    if (![true, false, 'true', 'false'].includes(value))
        throw competitionError('COMPETITION_INVALID_PRIVACY', 400);
    const enabled = value === true || value === 'true';
    if (enabled && user.isVerified !== true) throw competitionError('COMPETITION_VERIFICATION_REQUIRED', 403);
    if (enabled === (user.competitionPrivacy?.shareSettledPicks === true)) return;
    // Rotate on every change: links from a previous sharing period cannot revive.
    user.competitionPrivacy = { shareSettledPicks: enabled, publicId: enabled ? randomUUID() : undefined, revision: randomUUID() };
}

export function competitionProfileId(user, environment) {
    if (environment === 'development-fixtures') {
        const index=user?.testAccount?.index;
        return user?.testAccount?.seedId === 'match-discussions-v1' && Number.isInteger(index) && index>=1 && index<=20 ? `test-user-${String(index).padStart(2,'0')}` : null;
    }
    if (environment === 'development-demo') {
        const index = user?.testAccount?.index;
        return user?.testAccount?.seedId === 'match-discussions-v1' && Number.isInteger(index) && index >= 1 && index <= 19
            ? `demo-user-${String(index).padStart(2, '0')}` : null;
    }
    const privacy = user?.competitionPrivacy;
    return privacy?.shareSettledPicks === true && UUID.test(privacy.publicId || '') ? privacy.publicId : null;
}

export function competitionProfileQuery(id, environment) {
    if(environment === 'development-fixtures') {
        if(typeof id!=='string'||!/^test-user-(?:0[1-9]|1[0-9]|20)$/.test(id))throw competitionError('COMPETITION_PROFILE_UNAVAILABLE',404);
        return {isVerified:true,'accountClosure.requestedAt':{$exists:false},'testAccount.seedId':'match-discussions-v1','testAccount.index':Number(id.slice(-2))};
    }
    const demo = environment === 'development-demo';
    if (typeof id !== 'string' || !(demo ? DEMO : UUID).test(id))
        throw competitionError('COMPETITION_PROFILE_UNAVAILABLE', 404);
    return { isVerified: true, 'accountClosure.requestedAt': { $exists: false },
        ...(demo ? { 'testAccount.seedId': 'match-discussions-v1', 'testAccount.index': Number(id.slice(-2)) }
            : { 'competitionPrivacy.shareSettledPicks': true, 'competitionPrivacy.publicId': id }) };
}

/** Public responses intentionally exclude actor IDs, source metadata and revisions. */
export function sharedCompetitionPick(pick) {
    const s = pick.snapshot, result = pick.settlement;
    return { matchTPId: pick.matchTPId, side: pick.side, submittedAt: pick.submittedAt, month: pick.month,
        snapshot: { matchTPId: s.matchTPId, tournament: s.tournament, startAt: s.startAt, lockAt: s.lockAt,
            players: s.players.map(p => ({ id: p.id, name: p.name, countryISO2: p.countryISO2, countryISO3: p.countryISO3,
                countryFull: p.countryFull, seed: p.seed, rank: p.rank })), odds: s.odds, bookmakers: s.bookmakers,
            model: s.model ? { version: s.model.version, p1: s.model.p1, issuedAt: s.model.issuedAt } : null },
        settlement: { status: result.status, units: result.units, reason: result.reason, settledAt: result.settledAt } };
}
