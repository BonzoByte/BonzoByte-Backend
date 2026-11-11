import crypto from 'node:crypto';
import { normalizeEmail } from './accessPolicy.js';
export const BETA_COOKIE = '__Host-bonzobyte_beta';
export const BETA_SESSION_MS = 8 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => Object.assign(new Error('Beta verification failed.'), { code: 'BETA_VERIFICATION_FAILED' });
export function betaCookieToken(header = '') {
    const matches = header.split(';').map(s => s.trim()).filter(s => s.startsWith(BETA_COOKIE + '='));
    const token = matches.length === 1 ? matches[0].slice(BETA_COOKIE.length + 1) : '';
    return validToken(token) ? token : '';
}
export function createBetaAccess({ Challenge, Session, allowedEmails, codeSecret, sendMail, now = () => new Date() }) {
    const allowed = email => allowedEmails().has(normalizeEmail(email));
    const digestCode = (challenge, code) => crypto.createHmac('sha256', codeSecret).update(challenge + ':' + code).digest('hex');
    return {
        allowed,
        async request(emailInput) {
            const challenge = crypto.randomBytes(32).toString('hex'), email = normalizeEmail(emailInput);
            if (!allowed(email)) return challenge; // Same outward response, no mail/account creation.
            const at = now(), hourAgo = new Date(at.getTime() - 3600000);
            // One record per email serializes sends even across worker instances.
            try { await Challenge.updateOne({ email }, { $setOnInsert: { email, windowAt: at, windowCount: 0 } }, { upsert: true }); }
            catch (error) { if (error.code !== 11000) throw error; }
            const code = String(crypto.randomInt(1000000)).padStart(6, '0');
            const row = await Challenge.findOneAndUpdate({ email, $and: [
                { $or: [{ nextSendAt: null }, { nextSendAt: { $lte: at } }] },
                { $or: [{ windowAt: { $lte: hourAgo } }, { windowCount: { $lt: 5 } }] },
            ] }, [{ $set: { challengeHash: hash(challenge), codeHash: digestCode(challenge, code),
                expiresAt: new Date(at.getTime() + 10 * 60000), ready: false, usedAt: null, attempts: 0,
                nextSendAt: new Date(at.getTime() + 60000),
                windowCount: { $cond: [{ $lte: ['$windowAt', hourAgo] }, 1, { $add: ['$windowCount', 1] }] },
                windowAt: { $cond: [{ $lte: ['$windowAt', hourAgo] }, at, '$windowAt'] }, updatedAt: at,
            } }], { new: true, timestamps: false });
            if (!row) return challenge;
            try {
                await sendMail({ to: email, subject: 'BonzoByte — private beta access code',
                    text: `Your private BonzoByte beta access code is ${code}. It expires in 10 minutes and can be used once. This opens the private testing area, not an application account. If you did not request this, ignore this message.`,
                    html: `<p>Your private BonzoByte beta access code:</p><p style="font-size:32px;letter-spacing:6px">${code}</p><p>Expires in 10 minutes; one use only. This opens the private testing area, not an application account. If you did not request this, ignore this message.</p>` });
                await Challenge.updateOne({ _id: row._id, challengeHash: hash(challenge) }, { $set: { ready: true } });
            } catch { /* Fail closed. No retry after ambiguous mail acceptance, no PII in logs. */ }
            return challenge;
        },
        async verify(challenge, code) {
            if (!validToken(challenge) || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail();
            const at = now();
            const row = await Challenge.findOneAndUpdate({ challengeHash: hash(challenge), ready: true, usedAt: null,
                expiresAt: { $gt: at }, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } }, { new: true });
            if (!row || !allowed(row.email) || !/^[a-f0-9]{64}$/.test(row.codeHash || '')
                || !crypto.timingSafeEqual(Buffer.from(row.codeHash, 'hex'), Buffer.from(digestCode(challenge, code), 'hex'))) throw fail();
            const used = await Challenge.updateOne({ _id: row._id, challengeHash: hash(challenge), usedAt: null,
                expiresAt: { $gt: now() } }, { $set: { usedAt: now(), ready: false } });
            if (!used.modifiedCount) throw fail();
            const token = crypto.randomBytes(32).toString('hex');
            await Session.create({ email: row.email, tokenHash: hash(token), expiresAt: new Date(at.getTime() + BETA_SESSION_MS) });
            return token;
        },
        async session(token) {
            if (!validToken(token)) return null;
            const row = await Session.findOne({ tokenHash: hash(token), expiresAt: { $gt: now() } }).lean();
            return row && allowed(row.email) ? { email: row.email } : null;
        },
        async logout(token) { if (validToken(token)) await Session.deleteOne({ tokenHash: hash(token) }); },
    };
}
