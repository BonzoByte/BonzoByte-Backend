import test from 'node:test';
import assert from 'node:assert/strict';

import {
    evaluateDetailsAccess,
    getDetailsCachePolicy,
} from '../utils/detailsAccessPolicy.js';
import { buildDetailsLockedResponse } from '../utils/lockResponse.js';

const NOW = new Date('2026-07-27T10:00:00.000Z');

test('finished matches are universally open regardless of future start', () => {
    const result = evaluateDetailsAccess({
        isFinished: true,
        expectedStartUtc: '2026-07-29T12:00:00Z',
        now: NOW,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.universallyUnlocked, true);
    assert.equal(result.reason, 'finished');
    assert.deepEqual(getDetailsCachePolicy(result), {
        cacheControl: 'public, max-age=300',
        varyAuthorization: false,
    });
});

test('unfinished free match more than one hour away stays locked', () => {
    const result = evaluateDetailsAccess({
        isFinished: 'false',
        expectedStartUtc: '2026-07-27T11:00:00.001Z',
        now: NOW,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'future-locked');
});

test('unfinished free match unlocks at the exact one-hour boundary', () => {
    const result = evaluateDetailsAccess({
        expectedStartUtc: '2026-07-27T11:00:00.000Z',
        now: NOW,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.universallyUnlocked, true);
    assert.equal(result.reason, 'time-unlocked');
});

test('historical unfinished match is open', () => {
    const result = evaluateDetailsAccess({
        expectedStartUtc: '2020-01-02T12:00:00Z',
        now: NOW,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'time-unlocked');
});

test('privileged user receives early private access', () => {
    const result = evaluateDetailsAccess({
        isPrivileged: true,
        expectedStartUtc: '2026-07-29T12:00:00Z',
        now: NOW,
    });
    const cache = getDetailsCachePolicy(result);

    assert.equal(result.allowed, true);
    assert.equal(result.universallyUnlocked, false);
    assert.equal(result.reason, 'privileged');
    assert.deepEqual(cache, {
        cacheControl: 'private, no-store',
        varyAuthorization: true,
    });
});

test('invalid or missing start fails safely without ISO formatting crash', () => {
    for (const expectedStartUtc of [undefined, '', 'not-a-date', '2026-02-30T12:00:00']) {
        const result = evaluateDetailsAccess({ expectedStartUtc, now: NOW });
        const payload = buildDetailsLockedResponse(result);

        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'invalid-start');
        assert.equal(payload.expectedStartUtc, null);
        assert.equal(payload.unlocksAt, null);
        assert.match(payload.message, /scheduled start time is unavailable/i);
    }
});

test('midnight fallback stays locked through its listed day, then opens', () => {
    const duringListedDay = evaluateDetailsAccess({
        expectedStartUtc: '2026-07-27T00:00:00',
        now: NOW,
    });
    const afterListedDay = evaluateDetailsAccess({
        expectedStartUtc: '2026-07-27T00:00:00',
        now: new Date('2026-07-28T00:00:00.000Z'),
    });

    assert.equal(duringListedDay.allowed, false);
    assert.equal(duringListedDay.reason, 'unknown-time-locked');
    assert.equal(duringListedDay.unlocksAt.toISOString(), '2026-07-28T00:00:00.000Z');
    assert.equal(afterListedDay.allowed, true);
    assert.equal(afterListedDay.reason, 'unknown-time-day-ended');
});

test('synthetic midnight ordering milliseconds remain unknown time', () => {
    for (const expectedStartUtc of [
        '2026-07-27T00:00:00.001',
        '2026-07-27T00:00:00.002Z',
    ]) {
        const result = evaluateDetailsAccess({ expectedStartUtc, now: NOW });

        assert.equal(result.allowed, false);
        assert.equal(result.reason, 'unknown-time-locked');
        assert.equal(result.unlocksAt.toISOString(), '2026-07-28T00:00:00.000Z');
    }
});

test('only universally unlocked responses are publicly cacheable', () => {
    const locked = evaluateDetailsAccess({
        expectedStartUtc: '2026-07-29T12:00:00Z',
        now: NOW,
    });
    const publicResult = evaluateDetailsAccess({
        expectedStartUtc: '2026-07-27T11:00:00Z',
        now: NOW,
    });

    assert.deepEqual(getDetailsCachePolicy(locked), {
        cacheControl: 'private, no-store',
        varyAuthorization: true,
    });
    assert.deepEqual(getDetailsCachePolicy(publicResult), {
        cacheControl: 'public, max-age=300',
        varyAuthorization: false,
    });
});
