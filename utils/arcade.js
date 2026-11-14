import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { arcadeError } from './arcadeCatalog.js';
import { CURRENT_ARCADE_VERSION, arcadeKernel } from './arcadeKernels.js';
const require = createRequire(import.meta.url);
const { opponentStrength, opponentGameMu, ARCADE_PRIOR, updateArcadeRating, conservativeSkill } = require('./arcade-engine/tennis-skill.cjs');
export const ARCADE_ENGINE_VERSION = CURRENT_ARCADE_VERSION;
export const ARCADE_COLLECTIONS = Object.freeze({ arcadeProfiles: 'arcadeprofiles_development', arcadeSeasons: 'arcadeseasons_development', arcadeSessions: 'arcadesessions_development' });
export const ARCADE_RULES = Object.freeze({ trial: true, rewards: false, format: 'challenge', assist: true,
    dailyLimit: 10, opponentDailyLimit: 3, minimumGames: 10, retentionDays: 90, maxReplayBytes: 630000 });
let verifying = 0;
export async function verifyArcadeReplay(replay, config) {
    const engineVersion = config.engineVersion ?? ARCADE_ENGINE_VERSION;
    if (!arcadeKernel(engineVersion)) throw arcadeError('ARCADE_VERSION_CHANGED', 409);
    if (verifying >= 2) throw arcadeError('ARCADE_BUSY', 503);
    verifying++;
    try {
        return await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./arcadeReplayWorker.js', import.meta.url), { workerData: { replay, config: { ...config, engineVersion } }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
            let settled = false;
            const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); error ? reject(error) : resolve(result); };
            const timer = setTimeout(() => finish(arcadeError('ARCADE_REPLAY_INVALID')), 10000); timer.unref();
            worker.once('message', message => finish(message.ok ? null : arcadeError('ARCADE_REPLAY_INVALID'), message.result));
            worker.once('error', () => finish(arcadeError('ARCADE_REPLAY_INVALID')));
            worker.once('exit', () => { if (!settled) finish(arcadeError('ARCADE_REPLAY_INVALID')); });
        });
    } finally { verifying--; }
}
export const freshArcadeRating = () => ({ ...ARCADE_PRIOR });
export const rateArcade = (before, opponentMu, won) => ({ ...updateArcadeRating(before, opponentMu, won) });
export const showArcadeRating = rating => ({ ...rating, score: conservativeSkill(rating), provisional: rating.played < ARCADE_RULES.minimumGames });
export function createArcade({ store, catalog, available = () => true, now = () => new Date(), verify = verifyArcadeReplay }) {
    const ready = () => { if (!available()) throw arcadeError('ARCADE_UNAVAILABLE', 503); };
    const actorReady = actor => { ready(); if (!actor?.user) throw arcadeError('ARCADE_AUTH_REQUIRED', 401); };
    const expose = row => ({ id: row._id, seed: row.seed, engineVersion: row.engineVersion, opponent: row.opponent,
        surface: row.surface, format: 'challenge', assist: true, expiresAt: row.expiresAt, trial: true });
    return {
        async opponents(q) { ready(); return { ...await catalog.search(q), engineVersion: ARCADE_ENGINE_VERSION, rules: ARCADE_RULES }; },
        async me(actor) { actorReady(actor); return store.me(actor); },
        async leaderboard(month) { ready(); return { ...await store.leaderboard(month), month, rules: ARCADE_RULES }; },
        async start(actor, body) {
            actorReady(actor);
            if (!body || Object.keys(body).some(k => !['opponentId','surface','requestId','engineVersion','publicRanking'].includes(k)) ||
                !Number.isSafeInteger(body.opponentId) || body.opponentId <= 0 || !['grass','clay','hard'].includes(body.surface) ||
                !/^[a-f0-9-]{36}$/i.test(body.requestId || '') || body.publicRanking !== true) throw arcadeError('ARCADE_INVALID_BODY');
            if (body.engineVersion !== ARCADE_ENGINE_VERSION) throw arcadeError('ARCADE_VERSION_CHANGED', 409);
            const opponent = await catalog.get(body.opponentId), at = now();
            const row = await store.start(actor, { _id: randomUUID(), requestId: body.requestId, seed: randomBytes(4).readUInt32LE(),
                opponent: { ...opponent, strength: opponentStrength(opponent.ts), gameMu: opponentGameMu(opponent.ts) },
                engineVersion: ARCADE_ENGINE_VERSION, surface: body.surface, startedAt: at, day: at.toISOString().slice(0,10),
                month: at.toISOString().slice(0,7), expiresAt: new Date(+at + 2 * 3600000), status: 'active' });
            return expose(row);
        },
        async finish(actor, id, body) {
            actorReady(actor);
            if (!/^[a-f0-9-]{36}$/i.test(id) || !body || Object.keys(body).length !== 1 || typeof body.replay !== 'string' ||
                body.replay.length > 840000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.replay)) throw arcadeError('ARCADE_INVALID_BODY');
            const bytes = Buffer.from(body.replay, 'base64');
            if (!bytes.length || bytes.length > ARCADE_RULES.maxReplayBytes || bytes.length % 7 || bytes.toString('base64') !== body.replay) throw arcadeError('ARCADE_INVALID_BODY');
            const digest = createHash('sha256').update(bytes).digest('hex');
            const row = await store.session(actor, id);
            if (!row) throw arcadeError('ARCADE_SESSION_UNAVAILABLE', 404);
            if (row.status === 'complete') {
                if (row.replaySha256 !== digest) throw arcadeError('ARCADE_ALREADY_FINISHED', 409);
                return row.result;
            }
            if (!arcadeKernel(row.engineVersion)) throw arcadeError('ARCADE_VERSION_CHANGED', 409);
            if (row.status !== 'active' || row.expiresAt <= now()) throw arcadeError('ARCADE_SESSION_EXPIRED', 409);
            const result = await verify(body.replay, { seed: row.seed, strength: row.opponent.strength, surface: row.surface, engineVersion: row.engineVersion });
            if (+now() - +row.startedAt + 3000 < result.seconds * 1000 * .8) throw arcadeError('ARCADE_REPLAY_TOO_FAST');
            return store.finish(actor, id, digest, result);
        },
    };
}
