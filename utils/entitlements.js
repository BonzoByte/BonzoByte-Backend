import { getNow } from './now.js';
import {
    DEFAULT_DETAILS_LOCK_HOURS,
    evaluateDetailsAccess,
} from './detailsAccessPolicy.js';

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

export function hasPrivilegedMatchDetailsAccess(u) {
    return Boolean(u?.isAdmin || isPremium(u) || hasActiveTrial(u));
}

// Compatibility wrapper for callers that only need the allow/deny result.
export function canAccessFutureMatchDetails(
    u,
    expectedStartUtc,
    lockHours = DEFAULT_DETAILS_LOCK_HOURS
) {
    return evaluateDetailsAccess({
        isPrivileged: hasPrivilegedMatchDetailsAccess(u),
        expectedStartUtc,
        now: getNow(),
        lockHours,
    }).allowed;
}
