import jwt from 'jsonwebtoken';
import { sharedCompetitionPick } from './competitionPrivacy.js';
import { createHash, randomUUID } from 'node:crypto';
import { COMPETITION_RULES, competitionError, competitionEligibility, competitionSnapshot,
    snapshotHash, competitionSummary } from './competitionPolicy.js';

export function createCompetition({ store, secret, allowedSources = [], available = () => true, now = () => new Date() }) {
    const key = createHash('sha256').update('bonzobyte-competition-quote\0' + (secret || '')).digest('hex');
    const guard = () => { if (!available() || !secret) throw competitionError('COMPETITION_UNAVAILABLE'); };
    const publicPick = pick => pick ? ({ matchTPId: pick.matchTPId, side: pick.side, snapshot: pick.snapshot,
        submittedAt: pick.submittedAt, month: pick.month, settlement: pick.settlement }) : null;
    function decode(token, actor, id) {
        try {
            const payload = jwt.verify(token, key, { algorithms: ['HS256'], audience: 'competition', issuer: 'bonzobyte',
                clockTimestamp: Math.floor(+now() / 1000) });
            if (payload.sub !== String(actor.user) || payload.match !== id || typeof payload.hash !== 'string') throw new Error();
            return payload;
        } catch { throw competitionError('COMPETITION_QUOTE_EXPIRED', 409); }
    }
    return {
        rules: () => ({ ...COMPETITION_RULES, sourceConnected: allowedSources.length > 0 }),
        async match(actor, id) {
            guard(); const at = now();
            const [source, pick] = await Promise.all([store.readMatch(id), store.ownMatch(actor, id)]);
            const reason = pick ? 'alreadyPicked' : competitionEligibility(source, at, allowedSources);
            let quote = null;
            if (!reason) {
                const snapshot = competitionSnapshot(source);
                const token = jwt.sign({ match: id, hash: snapshotHash(snapshot), jti: randomUUID(), iat: Math.floor(+at / 1000) }, key,
                    { algorithm: 'HS256', subject: String(actor.user), audience: 'competition', issuer: 'bonzobyte', expiresIn: 90 });
                quote = { snapshot, token, expiresAt: new Date(+at + 90000).toISOString() };
            }
            const closed = source && (source.status !== 'scheduled' || +at >= +new Date(source.firstLockAt || +new Date(source.startAt) - 300000));
            return { available: !reason, reason, quote, pick: publicPick(pick),
                community: closed ? await store.community(id, at) : null, serverAt: at.toISOString() };
        },
        async submit(actor, id, body) {
            guard();
            if (!body || Object.keys(body).sort().join(',') !== 'side,token' || ![0, 1].includes(body.side)
                || typeof body.token !== 'string' || body.token.length > 2000)
                throw competitionError('COMPETITION_INVALID_BODY', 400);
            // Verify again inside the committing transaction; deadlines cannot be
            // bypassed by opening the dialog early or stalling a request.
            const pick = await store.accept(actor, id, ({ source, existing, used, at }) => {
                if (existing) {
                    if (existing.side === body.side && existing.quoteTokenHash === snapshotHash(body.token)) return existing;
                    throw competitionError('COMPETITION_ALREADY_PICKED', 409);
                }
                const quote = decode(body.token, actor, id);
                const reason = competitionEligibility(source, at, allowedSources);
                if (reason) throw competitionError('COMPETITION_LOCKED', 409);
                if (used >= COMPETITION_RULES.dailyLimit) throw competitionError('COMPETITION_DAILY_LIMIT', 409);
                const snapshot = competitionSnapshot(source);
                if (snapshotHash(snapshot) !== quote.hash) throw competitionError('COMPETITION_QUOTE_CHANGED', 409);
                return { rulesVersion: COMPETITION_RULES.version, side: body.side, stake: 1, snapshot,
                    quoteTokenHash: snapshotHash(body.token) };
            });
            return { pick: publicPick(pick) };
        },
        async me(actor, month) {
            guard(); const { rows, remainingToday } = await store.own(actor, month);
            return { month, remainingToday, entries: rows.map(publicPick), summary: competitionSummary(rows), rules: COMPETITION_RULES };
        },
        async leaderboard(month) {
            guard(); const result = await store.leaderboard(month);
            let previous = null, rank = 0;
            return { month, rules: COMPETITION_RULES, ...result, qualified: result.qualified.map((row, index) => {
                if (row.units !== previous) rank = index + 1;
                previous = row.units; return { ...row, rank };
            }) };
        },
        async publicPicks(id, month) {
            guard(); const { nickname, rows } = await store.publicPicks(id, month);
            const { settled, won, voided, units, roi, hitRate, qualified } = competitionSummary(rows);
            return { month, nickname, entries: rows.map(sharedCompetitionPick),
                summary: { settled, won, voided, units, roi, hitRate, qualified } };
        },
    };
}
