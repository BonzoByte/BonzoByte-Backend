import User from '../models/user.model.js';
import protect from '../middleware/auth.middleware.js';
import { createEmailVerificationService, VerificationError } from '../utils/emailVerification.js';
import sendVerificationEmail from '../utils/sendVerificationEmail.js';
import { readVerificationSession } from '../utils/verificationSession.js';
import { generateToken } from '../utils/generateToken.js';
import { getEntitlements } from '../utils/entitlements.js';
import { competitionPrivacyDto } from '../utils/competitionPrivacy.js';
import { isBetaAccountAllowed } from '../utils/accessPolicy.js';

export const emailVerification = createEmailVerificationService({ User, sendMail: sendVerificationEmail,
    secret: () => process.env.JWT_SECRET });

export async function verificationIdentity(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!req.body?.verificationTicket) return protect(req, res, next);
    try {
        const ticket = readVerificationSession(req.body.verificationTicket);
        const user = await User.findById(ticket.id);
        if (!user || user.email !== ticket.email || (user.tokenVersion ?? 0) !== ticket.version) throw new Error();
        if (!isBetaAccountAllowed(user.email)) return res.status(403).json({ code: 'BETA_EMAIL_NOT_ALLOWED' });
        req.user = user; req.verificationLogin = true;
        next();
    } catch { res.status(401).json({ code: 'VERIFICATION_SESSION_EXPIRED' }); }
}

const respond = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await fn(req)); }
    catch (error) {
        if (error instanceof VerificationError)
            return res.status(error.status).json({ code: error.code, verification: error.state });
        console.error('[VERIFICATION] Request failed');
        return res.status(500).json({ code: 'VERIFICATION_UNAVAILABLE' });
    }
};
export const verificationStatus = respond(req => emailVerification.status(req.user._id));
export const resendVerification = respond(req => emailVerification.send(req.user._id));
export const verifyEmailLink = respond(req => emailVerification.verifyLink(req.body?.token));
export const verifyEmailCode = respond(async req => {
    const result = await emailVerification.verifyCode(req.user._id, req.body?.code);
    // A verified password + email challenge can complete the interrupted login.
    if (req.verificationLogin) {
        const u = await User.findById(req.user._id);
        if (!u || !u.isVerified || u.email !== req.user.email || u.tokenVersion !== req.user.tokenVersion)
            throw new VerificationError('VERIFICATION_SESSION_EXPIRED', 401);
        return { ...result, token: generateToken(String(u._id), u.tokenVersion), user: {
            _id: String(u._id), email: u.email, name: u.name, nickname: u.nickname, avatarUrl: u.avatarUrl,
            isAdmin: !!u.isAdmin, isUser: !!u.isUser, isVerified: true, provider: u.provider, entitlements: getEntitlements(u),
            competitionPrivacy: competitionPrivacyDto(u),
        } };
    }
    return result;
});
