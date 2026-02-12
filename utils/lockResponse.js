export function buildDetailsLockedResponse(expectedStartUtc, lockHours = 2) {
    const start = new Date(expectedStartUtc);
    const unlockAt = new Date(start.getTime() - lockHours * 60 * 60 * 1000);

    return {
        status: 'error',
        code: 'DETAILS_LOCKED',
        lockHours,
        expectedStartUtc: start.toISOString(),
        unlocksAt: unlockAt.toISOString(),
        message: `Match details are locked until ${unlockAt.toISOString()}.`,
    };
}  