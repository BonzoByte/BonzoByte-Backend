const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

export const DEFAULT_DETAILS_LOCK_HOURS = 1;

/**
 * Evaluates the match-details access window without touching a database.
 *
 * Legacy archives encode an unavailable source time as midnight. Because a
 * real midnight start cannot currently be distinguished from that fallback,
 * every midnight value is treated conservatively as "time unknown": free
 * access begins when the listed UTC calendar day has ended. Finished and
 * privileged matches still bypass that fallback.
 */
export function evaluateDetailsAccess({
    isFinished = false,
    isPrivileged = false,
    expectedStartUtc,
    now = new Date(),
    lockHours = DEFAULT_DETAILS_LOCK_HOURS,
} = {}) {
    const normalizedLockHours = normalizeLockHours(lockHours);

    if (isFinishedValue(isFinished)) {
        return decision({
            allowed: true,
            universallyUnlocked: true,
            reason: 'finished',
            lockHours: normalizedLockHours,
        });
    }

    if (isPrivileged) {
        return decision({
            allowed: true,
            universallyUnlocked: false,
            reason: 'privileged',
            lockHours: normalizedLockHours,
        });
    }

    const nowAt = asValidDate(now);
    const schedule = parseExpectedStart(expectedStartUtc);

    if (!nowAt || !schedule) {
        return decision({
            allowed: false,
            universallyUnlocked: false,
            reason: 'invalid-start',
            lockHours: normalizedLockHours,
        });
    }

    const unlocksAt = schedule.hasKnownStartTime
        ? new Date(schedule.expectedStartAt.getTime() - normalizedLockHours * MILLISECONDS_PER_HOUR)
        : schedule.unknownTimeUnlocksAt;
    const allowed = nowAt.getTime() >= unlocksAt.getTime();

    return decision({
        allowed,
        universallyUnlocked: allowed,
        reason: schedule.hasKnownStartTime
            ? (allowed ? 'time-unlocked' : 'future-locked')
            : (allowed ? 'unknown-time-day-ended' : 'unknown-time-locked'),
        lockHours: normalizedLockHours,
        expectedStartAt: schedule.expectedStartAt,
        unlocksAt,
        hasKnownStartTime: schedule.hasKnownStartTime,
    });
}

/**
 * Only universally available detail archives may be stored by a shared cache.
 * Privileged early access and locked responses vary by Authorization.
 */
export function getDetailsCachePolicy(accessDecision) {
    if (accessDecision?.allowed && accessDecision?.universallyUnlocked) {
        return {
            cacheControl: 'public, max-age=300',
            varyAuthorization: false,
        };
    }

    return {
        cacheControl: 'private, no-store',
        varyAuthorization: true,
    };
}

function decision({
    allowed,
    universallyUnlocked,
    reason,
    lockHours,
    expectedStartAt = null,
    unlocksAt = null,
    hasKnownStartTime = null,
}) {
    return {
        allowed,
        universallyUnlocked,
        reason,
        lockHours,
        expectedStartAt,
        unlocksAt,
        hasKnownStartTime,
    };
}

function normalizeLockHours(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
        ? parsed
        : DEFAULT_DETAILS_LOCK_HOURS;
}

function isFinishedValue(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function asValidDate(value) {
    if (value == null) return null;

    const parsed = value instanceof Date
        ? new Date(value.getTime())
        : new Date(value);

    return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function parseExpectedStart(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    const raw = value.trim();
    const datePart = raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!datePart || !isValidIsoDatePart(datePart)) {
        return null;
    }

    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    // Ingestion adds synthetic milliseconds (.001, .002, ...) to otherwise
    // identical midnight fallbacks solely to preserve a deterministic order.
    const isMidnight = /T00:00(?::00(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/i.test(raw);
    const normalized = hasExplicitTimezone(raw) || isDateOnly ? raw : `${raw}Z`;
    const expectedStartAt = asValidDate(normalized);

    if (!expectedStartAt) {
        return null;
    }

    const listedDayStart = new Date(`${datePart}T00:00:00.000Z`);
    return {
        expectedStartAt,
        hasKnownStartTime: !(isDateOnly || isMidnight),
        unknownTimeUnlocksAt: new Date(listedDayStart.getTime() + MILLISECONDS_PER_DAY),
    };
}

function hasExplicitTimezone(value) {
    return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function isValidIsoDatePart(value) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
