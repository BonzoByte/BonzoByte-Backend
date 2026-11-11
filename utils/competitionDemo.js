import { createHash } from 'node:crypto';
import { SOCIAL_TEST_SEED, testAccountEnvironmentAllowed } from './developmentTestAccounts.js';
import { competitionError, competitionSnapshot, settleCompetitionPick, COMPETITION_RULES } from './competitionPolicy.js';

export const COMPETITION_DEMO_ENV = 'development-demo';
export const COMPETITION_DEMO_SEED = 'leaderboard-demo-v1';
const DAY = 86400000;
const random = key => createHash('sha256').update(key).digest().readUInt32BE(0) / 4294967296;
export function competitionDemoWindow(at = new Date()) {
    const end = Date.parse(at.toISOString().slice(0, 10));
    const previous = new Date(end); previous.setUTCDate(1); previous.setUTCMonth(previous.getUTCMonth() - 1);
    return { from: new Date(end - 30 * DAY).toISOString().slice(0, 10),
        to: new Date(end - DAY).toISOString().slice(0, 10), preferredMonth: previous.toISOString().slice(0, 7) };
}
export function assertCompetitionDemoUsers(users) {
    if (users.length !== 20) throw new Error('Exactly twenty existing marked development accounts required.');
    const indices = new Set();
    for (const user of users) {
        const i = user.testAccount?.index;
        if (user.testAccount?.seedId !== SOCIAL_TEST_SEED || !Number.isInteger(i) || i < 1 || i > 20
            || indices.has(i) || user.isVerified !== true || user.isAdmin === true || user.accountClosure?.requestedAt)
            throw new Error('Invalid, duplicate or closing development fixture account.');
        indices.add(i);
    }
}
/** Deterministic invented fixtures, NOT historical evidence or trusted feed observations.
 * Shared invented matches have consistent outcomes across all twenty accounts. */
export function competitionDemoPlan(users, at = new Date()) {
    assertCompetitionDemoUsers(users);
    const window = competitionDemoWindow(at), rows = [];
    for (let dayIndex = 0; dayIndex < 30; dayIndex++) {
        const midnight = Date.parse(window.from) + dayIndex * DAY;
        const day = new Date(midnight).toISOString().slice(0, 10);
        for (let slot = 0; slot < 3; slot++) {
            const matchTPId = 8000000000000000 + Math.floor(midnight / DAY) * 10 + slot;
            const submittedAt = new Date(midnight + (8 + slot * 4) * 3600000).toISOString();
            const startAt = new Date(Date.parse(submittedAt) + 3600000).toISOString();
            const settledAt = new Date(Date.parse(startAt) + 2 * 3600000).toISOString();
            const favourite = 1.35 + Math.round(random(day + slot + 'odds') * 90) / 100;
            const odds = [favourite, +(1 / (1.06 - 1 / favourite)).toFixed(2)];
            if (slot % 2) odds.reverse();
            const winner = random(day + slot + 'winner') < 1 / odds[0] / (1 / odds[0] + 1 / odds[1]) ? 0 : 1;
            const source = { schema: 'bonzobyte.competition-source.v1', matchTPId, revision: 1,
                source: COMPETITION_DEMO_SEED, sourceEventId: `demo-${day}-${slot}`, tournament: 'Demo Open — fictional match',
                players: [0, 1].map(side => ({ id: matchTPId + side + 1000000, name: `Demo Player ${dayIndex * 6 + slot * 2 + side + 1}` })),
                startAt, timePrecision: 'second', status: 'scheduled', statusObservedAt: submittedAt, oddsObservedAt: submittedAt,
                oddsKind: 'median', odds, bookmakers: 3, model: null };
            const snapshot = competitionSnapshot(source);
            const result = { ...source, revision: 2, status: 'finished', winner, resultVerified: true, statusObservedAt: settledAt };
            for (const user of [...users].sort((a, b) => a.testAccount.index - b.testAccount.index)) {
                const index = user.testAccount.index;
                // Sixteen active accounts and four with fewer than 30 settled picks.
                const participation = index <= 16 ? 0.78 - index * 0.008 : 0.20;
                if (random(`${day}-${slot}-${index}-participate`) > participation) continue;
                const hitChance = index <= 16 ? 0.79 - index * 0.025 : 0.43;
                const side = random(`${day}-${slot}-${index}-pick`) < hitChance ? winner : 1 - winner;
                const entry = { environment: COMPETITION_DEMO_ENV, userId: user._id, matchTPId, day, month: day.slice(0, 7),
                    rulesVersion: COMPETITION_RULES.version, side, stake: 1, snapshot, submittedAt,
                    quoteTokenHash: null, settlementHistory: [], fixture: { seedId: COMPETITION_DEMO_SEED, window } };
                entry.settlement = settleCompetitionPick(entry, result, new Date(settledAt));
                entry.fixture.fingerprint = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
                rows.push(entry);
            }
        }
    }
    return { window, rows };
}
export function pendingCompetitionDemoRows(plan, existing) {
    const byKey = new Map(existing.map(row => [`${row.userId}:${row.matchTPId}`, row]));
    const pending = [];
    for (const row of plan) {
        const old = byKey.get(`${row.userId}:${row.matchTPId}`);
        if (!old) pending.push(row);
        else if (old.fixture?.seedId !== COMPETITION_DEMO_SEED || old.fixture.fingerprint !== row.fixture.fingerprint)
            throw new Error('Existing competition demo record differs; nothing will be overwritten.');
    }
    return pending;
}
/** Explicit read-only demo view. Normal API calls never select the demo store. */
export function withCompetitionDemo({ normal, demo, metadata, allowed = () => testAccountEnvironmentAllowed() }) {
    const guard = () => { if (!allowed()) throw competitionError('COMPETITION_DEMO_UNAVAILABLE', 403); };
    return { ...normal,
        async rules() {
            let info = null;
            if (allowed()) try { info = await metadata(); } catch { /* Optional fixtures never block normal rules. */ }
            return { ...normal.rules(), demo: info };
        },
        async leaderboard(month, useDemo = false) {
            if (!useDemo) return normal.leaderboard(month);
            guard(); return { ...await demo.leaderboard(month), demo: true };
        },
        async me(actor, month, useDemo = false) {
            if (!useDemo) return normal.me(actor, month);
            guard(); return { ...await demo.me(actor, month), demo: true };
        },
        async publicPicks(id, month, useDemo = false) {
            if (!useDemo) return normal.publicPicks(id, month);
            guard(); return { ...await demo.publicPicks(id, month), demo: true };
        },
    };
}
