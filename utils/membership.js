import { evaluatePaidMembership, sandboxMembershipAllowed } from './paidMembership.js';
// Membership uses real time, never the historical/archive preview clock.
// Tests pass an explicit instant; no environment override can prolong paid access.
const timestamp = value => value ? new Date(value).getTime() : NaN;
const iso = value => Number.isFinite(timestamp(value)) ? new Date(value).toISOString() : null;

export function evaluateMembership(user, now = new Date(), options = {}) {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError('Invalid membership clock');
    const trialStart = user?.trial?.startedAt ?? user?.trial?.lastGrantedAt;
    const paid = (options.allowSandboxMembership ?? sandboxMembershipAllowed()) ? evaluatePaidMembership(user?.billingMembership, now) : null;
    const trialEnd = timestamp(paid ? paid.trialEndsAt : user?.trial?.endsAt);
    const hasTrial = paid ? paid.hasTrial : Number.isFinite(trialEnd) && trialEnd > nowMs
        && (!trialStart || timestamp(trialStart) <= nowMs);
    const subscription = user?.subscription;
    const legacyEnd = timestamp(subscription?.validUntil);
    const subscriptionEnd = paid?.premium ? timestamp(paid.premiumEndsAt) : legacyEnd;
    const active = subscription?.status === 'active';
    const lifetime = active && subscription?.isLifetime === true;
    const subscribed = !!paid?.premium || (active && (lifetime || legacyEnd > nowMs));
    const isVip = user?.vip?.enabled === true || lifetime;
    const premium = isVip || subscribed;
    const admin = user?.isAdmin === true;
    // Preserve an explicit manual ad waiver, but never persist expired trial/premium rights through metadata.
    const manualAdFree = user?.ads?.enabled === false
        && (!user.ads.disabledReason || user.ads.disabledReason === 'manual');
    const tier = admin ? 'admin' : isVip ? 'vip' : premium ? 'premium' : hasTrial ? 'trial' : 'standard';
    const adFreeReason = admin ? 'admin' : isVip ? 'vip' : premium ? 'premium'
        : hasTrial ? 'trial' : manualAdFree ? 'manual' : null;
    const nextChanges = [hasTrial ? trialEnd : NaN, subscribed && !lifetime ? subscriptionEnd : NaN]
        .filter(value => Number.isFinite(value) && value > nowMs);
    return {
        plan: premium ? 'premium' : 'free',
        tier,
        isPremium: premium,
        isVip,
        isLifetime: isVip,
        hasTrial,
        trialStartedAt: iso(trialStart),
        trialEndsAt: Number.isFinite(trialEnd) ? new Date(trialEnd).toISOString() : null,
        trialResumesAt: iso(paid?.trialResumesAt),
        trialRemainingMs: paid?.trialRemainingMs ?? Math.max(0, (trialEnd || 0) - nowMs),
        sandboxMembership: !!paid?.premium,
        subscriptionEndsAt: lifetime ? null : Number.isFinite(subscriptionEnd) ? new Date(subscriptionEnd).toISOString() : null,
        membershipEndsAt: tier === 'trial' && Number.isFinite(trialEnd) ? new Date(trialEnd).toISOString()
            : tier === 'premium' && Number.isFinite(subscriptionEnd) ? new Date(subscriptionEnd).toISOString() : null,
        showAds: !adFreeReason,
        adFreeReason,
        evaluatedAt: now.toISOString(),
        nextChangeAt: !admin && !isVip && nextChanges.length
            ? new Date(Math.min(...nextChanges)).toISOString() : null,
    };
}
