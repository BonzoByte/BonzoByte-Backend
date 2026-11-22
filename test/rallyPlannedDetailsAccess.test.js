import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { brotliCompressSync } from 'node:zlib';
import express from 'express';
import { evaluateDetailsAccess, getDetailsCachePolicy, DEFAULT_DETAILS_LOCK_HOURS } from '../utils/detailsAccessPolicy.js';
import { createDetailsScheduleResolver } from '../utils/plannedDetailsSchedule.js';
import { createPrivateArchivesRouter } from '../routes/privateArchives.routes.js';
import { buildDetailsLockedResponse } from '../utils/lockResponse.js';

const located = { tp: 827555980, day: '2026-11-22' };
const match = { m001: located.tp, m003: '2026-11-22T00:00:00.002', m004: 789472, m005: 679596 };
const planned = '2026-11-22T14:30:00.000Z'; // 15:30 in Zagreb
const feed = { schema: 'bonzobyte.planned-match-schedule.v1', day: '20261122',
    observedAt: '2026-11-22T12:15:09.891Z', slots: [[located.tp, match.m004, match.m005, planned]] };

test('verified Monastir schedule opens free details exactly two hours before kickoff', async () => {
    const resolve = createDetailsScheduleResolver(url => {
        assert.equal(url, 'https://bonzobyte.com/api/match-schedule/20261122');
        return Response.json(feed);
    });
    for (const [utc, allowed] of [['12:29:59', false], ['12:30:00', true], ['13:12:00', true]]) {
        const now = new Date(`2026-11-22T${utc}Z`);
        const schedule = await resolve({ located, match, now });
        const access = evaluateDetailsAccess({ expectedStartUtc: match.m003, ...schedule, now });
        assert.equal(access.allowed, allowed);
        assert.equal(access.unlocksAt.toISOString(), '2026-11-22T12:30:00.000Z');
    }
});

test('unknown clock, source outage, and contradictory player order are distinct', async () => {
    const now = new Date('2026-11-22T12:30:00Z');
    const missing = await createDetailsScheduleResolver(() => Response.json({ ...feed,
        slots: [[827555981, match.m004, match.m005, planned]] }))({ located, match, now });
    const access = evaluateDetailsAccess({ ...missing, now });
    assert.equal(access.reason, 'unknown-time-open');
    assert.equal(access.hasKnownStartTime, false);
    assert.equal(access.unlocksAt, null);
    assert.deepEqual(await createDetailsScheduleResolver(() => new Response(null, { status: 404 }))({ located, match, now }), { unavailable: true });
    assert.deepEqual(await createDetailsScheduleResolver(() => Response.json(feed))({ located, match: { ...match, m004: 3 }, now }), { unavailable: true });
    assert.equal(evaluateDetailsAccess({ ...missing, expectedStartUtc: '2026-11-22T19:00:00Z', now }).allowed, false);
});

test('anonymous detail HTTP route returns the match only after the two-hour cutoff', async t => {
    const app = express(), decoded = Buffer.from(JSON.stringify(match));
    const raw = brotliCompressSync(decoded);
    let now = new Date('2026-11-22T12:29:59Z');
    const reader = { releaseId: 'local-fixture', locateMatchByTp: async () => located,
        readVerified: async () => ({ raw, decoded }) };
    app.use('/api/archives', createPrivateArchivesRouter({ reader, optionalAuth: (_req, _res, next) => next(),
        loadAccessPolicies: async () => ({ evaluateDetailsAccess, getDetailsCachePolicy, DEFAULT_DETAILS_LOCK_HOURS,
            buildDetailsLockedResponse, getNow: () => now, hasPrivilegedMatchDetailsAccess: () => false,
            projectPublicDailyMatch: value => value }),
        resolveDetailsSchedule: createDetailsScheduleResolver(() => Response.json(feed)),
    }));
    const server = app.listen(0, '127.0.0.1');
    t.after(() => { server.closeAllConnections(); server.close(); });
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/archives/match-details/${located.tp}`;
    const before = await fetch(url);
    assert.equal(before.status, 423);
    assert.equal((await before.json()).unlocksAt, '2026-11-22T12:30:00.000Z');
    now = new Date('2026-11-22T12:30:00Z');
    const open = await fetch(url);
    assert.equal(open.status, 200);
    assert.match(open.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await open.arrayBuffer()), raw);
});
