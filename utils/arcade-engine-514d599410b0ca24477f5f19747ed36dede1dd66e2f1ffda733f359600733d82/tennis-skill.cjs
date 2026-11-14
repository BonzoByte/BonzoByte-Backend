"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARCADE_PRIOR = void 0;
exports.opponentStrength = opponentStrength;
exports.opponentGameMu = opponentGameMu;
exports.conservativeSkill = conservativeSkill;
exports.updateArcadeRating = updateArcadeRating;
exports.arcadeRandom = arcadeRandom;
exports.ARCADE_PRIOR = Object.freeze({ mu: 25, sigma: 25 / 3, played: 0, won: 0 });
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
function opponentStrength(ts) {
    if (!Number.isFinite(ts) || ts < -100 || ts > 100)
        throw Error('Invalid opponent TS');
    return clamp((ts - 15) / 25, 0, 1);
}
function opponentGameMu(ts) { return 15 + 20 * opponentStrength(ts); }
function conservativeSkill(rating) { return rating.mu - 3 * rating.sigma; }
function normalCdf(x) {
    const z = Math.abs(x), t = 1 / (1 + .2316419 * z);
    const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t *
        (.319381530 + t * (-.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
}
/** One-sided TrueSkill-style update against a fixed arcade AI anchor. */
function updateArcadeRating(before, opponentMu, won) {
    if (!Number.isFinite(before.mu) || before.mu < 0 || before.mu > 50 || !Number.isFinite(before.sigma) ||
        before.sigma < .5 || before.sigma > 25 / 3 + .001 || !Number.isFinite(opponentMu) || opponentMu < 15 || opponentMu > 35 ||
        !Number.isSafeInteger(before.played) || before.played < 0 || !Number.isSafeInteger(before.won) || before.won < 0 || before.won > before.played)
        throw Error('Invalid arcade rating');
    const variance = before.sigma ** 2 + (25 / 300) ** 2;
    const c = Math.sqrt(variance + 2 * (25 / 6) ** 2 + 1);
    const sign = won ? 1 : -1, t = sign * (before.mu - opponentMu) / c;
    const v = Math.exp(-t * t / 2) / Math.sqrt(2 * Math.PI) / Math.max(1e-12, normalCdf(t));
    const w = clamp(v * (v + t), 0, 1);
    return { mu: clamp(before.mu + sign * variance / c * v, 0, 50),
        sigma: clamp(Math.sqrt(variance * Math.max(.0001, 1 - variance / (c * c) * w)), .5, 25 / 3),
        played: before.played + 1, won: before.won + Number(won) };
}
function arcadeRandom(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
        throw Error('Invalid seed');
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
