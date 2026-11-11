import { getNow } from './now.js';
import { evaluateMembership } from './membership.js';
import {
    DEFAULT_DETAILS_LOCK_HOURS,
    evaluateDetailsAccess,
} from './detailsAccessPolicy.js';

export function hasActiveTrial(u) {
    return evaluateMembership(u).hasTrial;
}

export function hasActiveSubscription(u) {
    return evaluateMembership({ subscription: u?.subscription, billingMembership: u?.billingMembership }).isPremium;
}

export function isPremium(u) {
    return evaluateMembership(u).isPremium;
}

export function shouldShowAds(u) {
    return evaluateMembership(u).showAds;
}

export function getEntitlements(u) {
    return evaluateMembership(u);
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
