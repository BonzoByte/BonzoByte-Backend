import { getNow } from './now.js';

export function hasActiveTrial(u) {
    const ends = u?.trial?.endsAt ? new Date(u.trial.endsAt) : null;
    return Boolean(ends && ends > new Date());
}

export function hasActiveSubscription(u) {
    if (u?.subscription?.isLifetime) return true;

    const until = u?.subscription?.validUntil ? new Date(u.subscription.validUntil) : null;
    return Boolean(until && until > new Date() && u?.subscription?.status === 'active');
}

export function isPremium(u) {
    return u?.plan === 'premium' || hasActiveSubscription(u);
}

export function shouldShowAds(u) {
    if (!u) return true;
    if (u.isAdmin) return false;
    if (u.ads?.enabled === false) return false;
    if (isPremium(u)) return false;
    if (hasActiveTrial(u)) return false;
    return true;
}

export function getEntitlements(u) {
    const premium = isPremium(u);
    const trial = hasActiveTrial(u);

    return {
        plan: u?.plan ?? 'free',
        isPremium: premium,
        hasTrial: trial,
        trialEndsAt: u?.trial?.endsAt ?? null,
        showAds: shouldShowAds(u),
    };
}

// future match details lock: 2h before start (as agreed)
export function canAccessFutureMatchDetails(u, expectedStartUtc, lockHours = 2) {
    if (u?.isAdmin) return true;
    if (isPremium(u) || hasActiveTrial(u)) return true;

    const start = new Date(expectedStartUtc);
    const unlockAt = new Date(start.getTime() - lockHours * 60 * 60 * 1000);
    return getNow() >= unlockAt;
}