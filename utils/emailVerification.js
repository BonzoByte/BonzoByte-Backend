import crypto from 'node:crypto';

export const VERIFICATION_TTL_MS = 5 * 60_000;
export const VERIFICATION_COOLDOWN_MS = 60_000;
export const VERIFICATION_WINDOW_MS = 15 * 60_000;
export const VERIFICATION_MAX_ATTEMPTS = 5;
const MAX_SENDS = 5, MAX_FAILURES = 20;

export class VerificationError extends Error {
    constructor(code, status = 400, state) { super(code); this.code = code; this.status = status; this.state = state; }
}
export const hashVerificationLink = token => crypto.createHash('sha256').update(token).digest('hex');
export function hashVerificationCode(secret, userId, challenge, code) {
    return crypto.createHmac('sha256', secret).update(`email-verification\0${userId}\0${challenge}\0${code}`).digest('hex');
}
const equalDigest = (a, b) => typeof a === 'string' && a.length === b.length
    && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// All state transitions use compare-and-swap on one user document. Concurrent requests
// cannot reset attempt counts, send multiple challenges, or consume a code/link twice.
export function createEmailVerificationService({ User, sendMail, secret, now = Date.now }) {
    const read = id => User.findById(id).select('+verification').lean();
    const publicState = (user, time = now()) => {
        const v = user?.verification;
        return {
            verified: !!user?.isVerified, email: user?.email,
            serverNow: new Date(time).toISOString(),
            expiresAt: v?.expiresAt ? new Date(v.expiresAt).toISOString() : null,
            resendAt: v ? new Date(Math.max(new Date(v.resendAt).getTime() || 0,
                v.sends >= MAX_SENDS || v.failures >= MAX_FAILURES ? new Date(v.windowAt).getTime() + VERIFICATION_WINDOW_MS : 0)).toISOString() : null,
            attemptsRemaining: v ? Math.max(0, VERIFICATION_MAX_ATTEMPTS - v.attempts) : 0,
            delivery: v?.delivery ?? 'none',
        };
    };
    const casFilter = (user) => ({ _id: user._id, email: user.email, isVerified: { $ne: true },
        'verification.revision': user.verification?.revision ?? { $exists: false } });
    async function change(user, state) {
        const result = await User.updateOne(casFilter(user), { $set: { verification: state } });
        return result.modifiedCount === 1;
    }
    function windowState(v, time) {
        if (!v?.windowAt || time >= new Date(v.windowAt).getTime() + VERIFICATION_WINDOW_MS)
            return { windowAt: new Date(time), sends: 0, failures: 0 };
        return { windowAt: v.windowAt, sends: v.sends || 0, failures: v.failures || 0 };
    }
    async function status(id) {
        const user = await read(id);
        if (!user) throw new VerificationError('VERIFICATION_SESSION_EXPIRED', 401);
        return publicState(user);
    }
    async function send(id) {
        for (let retry = 0; retry < 8; retry++) {
            const user = await read(id), time = now();
            if (!user) throw new VerificationError('VERIFICATION_SESSION_EXPIRED', 401);
            if (user.isVerified) return publicState(user);
            const v = user.verification, window = windowState(v, time);
            if (window.sends >= MAX_SENDS || window.failures >= MAX_FAILURES || time < new Date(v?.resendAt || 0).getTime())
                throw new VerificationError('VERIFICATION_RATE_LIMIT', 429, publicState(user));
            const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
            const token = crypto.randomBytes(32).toString('hex'), challenge = crypto.randomUUID();
            const state = { ...window, sends: window.sends + 1, revision: crypto.randomUUID(), challenge,
                codeHash: hashVerificationCode(secret(), String(user._id), challenge, code),
                linkHash: hashVerificationLink(token), attempts: 0,
                expiresAt: new Date(time + VERIFICATION_TTL_MS), resendAt: new Date(time + VERIFICATION_COOLDOWN_MS),
                delivery: 'pending' };
            if (!await change(user, state)) continue;
            let delivery = 'sent';
            try { await sendMail(user.email, user, { code, token }); }
            catch { delivery = 'failed'; } // Never log codes, links or transport payloads.
            await User.updateOne({ _id: user._id, 'verification.challenge': challenge },
                { $set: { 'verification.delivery': delivery } });
            const current = await status(id);
            if (delivery === 'failed') throw new VerificationError('VERIFICATION_MAIL_FAILED', 503, current);
            return current;
        }
        throw new VerificationError('VERIFICATION_RETRY', 409);
    }
    async function consume(user, time) {
        const result = await User.updateOne({ ...casFilter(user), 'verification.expiresAt': { $gt: new Date(time) },
            'verification.attempts': { $lt: VERIFICATION_MAX_ATTEMPTS } }, {
            $set: { isVerified: true, isUser: true }, $unset: { verification: '' },
        });
        return result.modifiedCount === 1;
    }
    async function verifyCode(id, code) {
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new VerificationError('VERIFICATION_INVALID_CODE');
        for (let retry = 0; retry < 12; retry++) {
            const user = await read(id), v = user?.verification, time = now();
            if (!v || user.isVerified) throw new VerificationError('VERIFICATION_EXPIRED', 400, user ? publicState(user) : undefined);
            const window = windowState(v, time);
            if (v.attempts >= VERIFICATION_MAX_ATTEMPTS || window.failures >= MAX_FAILURES)
                throw new VerificationError('VERIFICATION_ATTEMPTS_EXHAUSTED', 429, publicState(user));
            if (time >= new Date(v.expiresAt).getTime()) throw new VerificationError('VERIFICATION_EXPIRED', 400, publicState(user));
            if (equalDigest(v.codeHash, hashVerificationCode(secret(), String(id), v.challenge, code))) {
                if (await consume(user, time)) return { verified: true };
            } else {
                const state = { ...v, ...window, attempts: v.attempts + 1, failures: window.failures + 1, revision: crypto.randomUUID() };
                if (await change(user, state)) throw new VerificationError(state.attempts >= VERIFICATION_MAX_ATTEMPTS
                    ? 'VERIFICATION_ATTEMPTS_EXHAUSTED' : 'VERIFICATION_INVALID_CODE', 400,
                    publicState({ ...user, verification: state }));
            }
        }
        throw new VerificationError('VERIFICATION_RETRY', 409);
    }
    async function verifyLink(token) {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new VerificationError('VERIFICATION_EXPIRED');
        const user = await User.findOne({ 'verification.linkHash': hashVerificationLink(token), isVerified: { $ne: true } })
            .select('+verification').lean();
        if (!user || !await consume(user, now())) throw new VerificationError('VERIFICATION_EXPIRED');
        return { verified: true };
    }
    return { status, send, verifyCode, verifyLink };
}
