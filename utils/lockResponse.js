export function buildDetailsLockedResponse(accessDecision) {
    const expectedStartUtc = toIsoOrNull(accessDecision?.expectedStartAt);
    const unlocksAt = toIsoOrNull(accessDecision?.unlocksAt);
    const message = unlocksAt
        ? `Match details are locked until ${unlocksAt}.`
        : 'Match details are locked because the scheduled start time is unavailable.';

    return {
        status: 'error',
        code: 'DETAILS_LOCKED',
        reason: accessDecision?.reason || 'invalid-start',
        lockHours: accessDecision?.lockHours ?? 1,
        expectedStartUtc,
        unlocksAt,
        message,
    };
}

function toIsoOrNull(value) {
    if (value == null) return null;

    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
