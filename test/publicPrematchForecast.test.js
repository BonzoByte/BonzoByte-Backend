import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overlayPublicPrematchForecasts } from '../utils/publicPrematchForecast.js';

const day = '20261122';
const lookedAt = Date.parse('2026-11-22T13:59:00Z');
const match = { matchTPId: 1, matchId: 4, player1TPId: 3, player2TPId: 7, isFinished: false,
    qualityStatus: 'NotAssessed', predictionEligible: false, calculationEligible: false,
    modelProbabilityPlayer1: null, player1Odds: null, result: null };
const row = { matchTPId: 1, matchId: 4, player1TPId: 3, player2TPId: 7, p1: .625,
    sourceObservedAtUtc: '2026-11-22T13:45:00Z', issuedAtUtc: '2026-11-22T13:50:00Z', earliestScheduledStartUtc: '2026-11-22T14:00:00Z' };
const packet = { schema: 'bonzobyte.public-prematch-grid.v1', day, rows: [row] };

test('public model presentation adds probabilities without granting grading, odds or game eligibility', () => {
    const [draft] = overlayPublicPrematchForecasts([match], packet, day, lookedAt);
    assert.deepEqual(draft, { ...match, modelProbabilityPlayer1: 62.5, modelProbabilityPlayer2: 37.5,
        publicForecastIssuedAtUtc: '2026-11-22T13:50:00.000Z' });
});

test('holds switched players, in-progress/final results, late model runs and duplicated IDs', () => {
    for (const m of [{ ...match, player1TPId: 7, player2TPId: 3 }, { ...match, result: '10' }, { ...match, isFinished: true }]) {
        assert.equal(overlayPublicPrematchForecasts([m], packet, day, lookedAt)[0], m);
    }
    for (const rows of [[row, row], [{ ...row, earliestScheduledStartUtc: row.issuedAtUtc }]]) {
        assert.equal(overlayPublicPrematchForecasts([match], { ...packet, rows }, day, lookedAt)[0], match);
    }
});
