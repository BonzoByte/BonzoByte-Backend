import crypto from 'node:crypto';

export const REFERRAL_DAYS = 7;
export const REFERRAL_MIN_AGE_MS = 120_000;
export const REFERRAL_INVITATION_LIMIT = 2;
// Lifetime budget: neither the calendar nor invitation TTL cleanup replenishes it.
// Carry forward known usage from the earlier daily-limit implementation.
export const referralInvitationsUsedExpression = { $max: [0,
    { $ifNull: ['$referral.invitationsUsed', 0] },
    { $ifNull: ['$referral.emailWindowCount', 0] },
    { $ifNull: ['$referral.count', 0] },
] };
export function referralQuota(user) {
    const used = Math.max(0, user.referral?.invitationsUsed ?? 0,
        user.referral?.emailWindowCount ?? 0, user.referral?.count ?? 0);
    return { invitationLimit: REFERRAL_INVITATION_LIMIT,
        remainingInvitations: Math.max(0, REFERRAL_INVITATION_LIMIT - used) };
}
export const REFERRAL_SECTIONS = ['matches', 'players', 'tournaments', 'analytics', 'model-insights', 'simulation'];
export const referralError = (code, status = 400) => Object.assign(new Error(code), { code, status });
export const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
export const validReferralToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
export const normalizeEmail = email => String(email ?? '').trim().toLowerCase();
export function canonicalEmail(email) {
    const [local, domain] = normalizeEmail(email).split('@');
    if (!domain) return '';
    return ['gmail.com', 'googlemail.com'].includes(domain)
        ? local.split('+')[0].replaceAll('.', '') + '@gmail.com'
        : local.split('+')[0] + '@' + domain;
}
export function canClaimInvitation(invitation, user, sender, now) {
    return !!invitation && invitation.delivery === 'sent' && invitation.expiresAt > now
        && !!sender?.isVerified && String(sender._id) !== String(user._id)
        && canonicalEmail(sender.email) !== canonicalEmail(user.email)
        && canonicalEmail(invitation.recipientEmail) === canonicalEmail(user.email)
        && new Date(user.createdAt) >= new Date(invitation.createdAt)
        && !user.referral?.referredBy;
}
export function isReferralQualified(user, now) {
    return user.isVerified && !!user.referral?.referredBy && !user.referral?.rewardedAt
        && new Date(user.referral.firstActivityAt).getTime() > 0
        && now.getTime() - new Date(user.referral.firstActivityAt).getTime() >= REFERRAL_MIN_AGE_MS
        && new Set((user.referral.activitySections ?? []).filter(s => REFERRAL_SECTIONS.includes(s))).size >= 3;
}
export function referralRewardPipeline(referredId, now) {
    return [{ $set: {
        'trial.startedAt': { $ifNull: ['$trial.startedAt', now] },
        'trial.endsAt': { $add: [{ $max: [{ $ifNull: ['$trial.endsAt', now] }, now] }, REFERRAL_DAYS * 86400000] },
        'trial.grantedDaysTotal': { $add: [{ $ifNull: ['$trial.grantedDaysTotal', 0] }, REFERRAL_DAYS] },
        'trial.lastGrantedAt': now,
        // The same atomic reward marker also credits a paused trial. The ledger
        // decides whether this time is consumed now or after paid access ends.
        billingMembership: { $cond: [
            { $eq: ['$billingMembership.version', 1] },
            { $mergeObjects: ['$billingMembership', { trialCredits:
                { $concatArrays: [{ $ifNull: ['$billingMembership.trialCredits', []] },
                    [{ at: now, durationMs: REFERRAL_DAYS * 86400000, referralId: referredId }]] } }] },
            '$$REMOVE',
        ] },
        'referral.count': { $add: [{ $ifNull: ['$referral.count', 0] }, 1] },
        'referral.lastReferralAt': now,
        'referral.rewardedUserIds': { $setUnion: [{ $ifNull: ['$referral.rewardedUserIds', []] }, [referredId]] },
    } }];
}
export function referralLink(frontend, token) {
    const url = new URL('/register', frontend);
    // Fragments stay out of HTTP access logs and the app's analytics page path.
    url.hash = 'ref=' + token;
    return url.toString();
}
export function invitationMail({ to, senderName, link, from }) {
    const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const intro = `${senderName} invited you to try BonzoByte, a tennis statistics platform.`;
    const terms = 'If you create and verify a new account, sign in and explore at least three sections over two minutes, your friend receives 7 extra trial days. No payment is required. This invitation expires in 30 days. If you did not expect this invitation, you can ignore it; no reminder will be sent.';
    return { to, from, subject: 'An invitation to BonzoByte',
        text: `${intro}\n\nRegister: ${link}\n\n${terms}`,
        html: `<p>${escape(intro)}</p><p><a href="${escape(link)}">Register at BonzoByte</a></p><p>${escape(terms)}</p>` };
}
