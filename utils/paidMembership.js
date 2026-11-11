// Replay only locally recorded entitlements, never browser clocks or provider requests.
// Keeping credits and purchase windows makes expiry/restarts/refunds deterministic.
export const DAY_MS = 86400000;
export const PLAN_MEMBERSHIP_VERSION = 1;
const ms = value => value ? new Date(value).getTime() : NaN;
export function sandboxMembershipAllowed(source = process.env) {
    return source.NODE_ENV !== 'production' && source.PAYPAL_MEMBERSHIP_ENABLED === 'true';
}
export function paidMembershipWindows(grants = []) {
    const windows = []; let previousEnd = -Infinity;
    for (const grant of [...grants].sort((a, b) => ms(a.paidAt) - ms(b.paidAt) || String(a.paymentId).localeCompare(String(b.paymentId)))) {
        const paidAt = ms(grant.paidAt), duration = Number(grant.durationMs);
        if (!Number.isFinite(paidAt) || !Number.isFinite(duration) || duration <= 0) continue;
        const start = Math.max(paidAt, previousEnd);
        const revoked = ms(grant.revokedAt);
        const end = Math.max(start, Math.min(start + duration, Number.isFinite(revoked) ? revoked : Infinity));
        // A queued, refunded purchase contributes no time; surviving purchases move forward.
        if (end > start) { windows.push({ start, end, paymentId: String(grant.paymentId) }); previousEnd = end; }
    }
    return windows;
}
export function evaluatePaidMembership(state, now = new Date()) {
    const at = now.getTime(), base = ms(state?.baselineAt);
    if (state?.version !== PLAN_MEMBERSHIP_VERSION || state?.environment !== 'sandbox'
        || !Number.isFinite(base) || base > at) return null;
    const windows = paidMembershipWindows(state.grants);
    const credits = [{ at: base, amount: Math.max(0, Number(state.baselineTrialMs) || 0) },
        ...(state.trialCredits ?? []).map(c => ({ at: ms(c.at), amount: Math.max(0, Number(c.durationMs) || 0) }))]
        .filter(c => Number.isFinite(c.at) && c.at >= base && c.at <= at);
    const points = [...new Set([base, at, ...credits.map(c => c.at),
        ...windows.flatMap(w => [w.start, w.end]).filter(t => t >= base && t <= at)])].sort((a, b) => a - b);
    let remaining = 0, cursor = base;
    for (const point of points) {
        const covered = windows.some(w => w.start <= cursor && w.end > cursor);
        if (!covered) remaining = Math.max(0, remaining - (point - cursor));
        for (const credit of credits) if (credit.at === point) remaining += credit.amount;
        cursor = point;
    }
    const current = windows.find(w => w.start <= at && w.end > at);
    let premiumEnd = current?.end;
    // Adjacent renewals are one uninterrupted period, not a sequence of UI expiries.
    if (current) for (const w of windows) if (w.start <= premiumEnd && w.end > premiumEnd) premiumEnd = w.end;
    const lastEnd = windows.at(-1)?.end;
    return { premium: !!current, premiumEndsAt: premiumEnd ? new Date(premiumEnd) : lastEnd ? new Date(lastEnd) : null,
        trialRemainingMs: remaining, trialResumesAt: current && remaining > 0 ? new Date(premiumEnd) : null,
        trialEndsAt: remaining > 0 ? new Date((premiumEnd ?? at) + remaining) : null,
        hasTrial: !current && remaining > 0 };
}
