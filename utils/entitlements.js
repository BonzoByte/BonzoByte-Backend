import { getNow } from './now.js';

export function hasActiveTrial(u) {
    const ends = u?.trial?.endsAt ? new Date(u.trial.endsAt) : null;
    return Boolean(ends && ends > getNow());
}

export function hasActiveSubscription(u) {
    if (u?.subscription?.isLifetime) return true;

    const until = u?.subscription?.validUntil ? new Date(u.subscription.validUntil) : null;
    return Boolean(until && until > getNow() && u?.subscription?.status === 'active');
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

// Future match details unlock shortly before the expected start time unless the user is privileged.
export function canAccessFutureMatchDetails(u, expectedStartUtc, lockHours = 2) {
    // Allows local UI testing of the locked-state branch without changing user data.
    if (process.env.DEV_FORCE_LOCK === '1') {
        return false;
    }

    if (u?.isAdmin) return true;
    if (isPremium(u) || hasActiveTrial(u)) return true;

    const start = new Date(expectedStartUtc);
    const unlockAt = new Date(start.getTime() - lockHours * 60 * 60 * 1000);

    return getNow() >= unlockAt;
}
