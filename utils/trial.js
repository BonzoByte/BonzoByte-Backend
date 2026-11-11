export const INITIAL_TRIAL_DAYS = 7;

export function createInitialTrial(registeredAt = new Date()) {
    const start = new Date(registeredAt);
    if (!Number.isFinite(start.getTime())) throw new TypeError('Invalid registration date');
    return {
        startedAt: start,
        endsAt: new Date(start.getTime() + INITIAL_TRIAL_DAYS * 86400000),
        grantedDaysTotal: INITIAL_TRIAL_DAYS,
        lastGrantedAt: start,
    };
}

// Compatibility helper: existing accounts must never gain a fresh trial on login/OAuth linking.
export function grantInitialTrialIfMissing(user) {
    if (!user?.isNew || user.trial?.startedAt || user.trial?.endsAt
        || user.trial?.lastGrantedAt || user.trial?.grantedDaysTotal > 0) return false;
    user.trial = createInitialTrial();
    return true;
}
