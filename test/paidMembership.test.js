import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, evaluatePaidMembership, paidMembershipWindows, sandboxMembershipAllowed } from '../utils/paidMembership.js';
import { evaluateMembership } from '../utils/membership.js';
import { BILLING_PLANS } from '../config/billingPlans.js';
const epoch = Date.parse('2026-10-01T12:00:00Z');
const date = days => new Date(epoch + days * DAY_MS);
const state = () => ({ version: 1, environment: 'sandbox', baselineAt: date(0), baselineTrialMs: 7 * DAY_MS, grants: [], trialCredits: [] });
const grant = (paid = 2, days = 30, id = 'A') => ({ paymentId: id, paidAt: date(paid), durationMs: days * DAY_MS });
const rights = (s, days) => evaluateMembership({ billingMembership: s }, date(days), { allowSandboxMembership: true });
test('real-duration plans use exact prices and UTC elapsed days, never five minutes', () => {
    for (const [key, amount, days] of [['daily', .5, 1], ['monthly', 10, 30], ['semiannual', 45, 182], ['annual', 60, 365]]) {
        assert.equal(BILLING_PLANS[key].priceEur, amount); assert.equal(BILLING_PLANS[key].durationDays, days);
        const s = state(); s.baselineTrialMs = 0; s.grants = [grant(0, days)];
        assert.equal(rights(s, days - .0001).tier, 'premium'); assert.equal(rights(s, days).tier, 'standard');
    }
});
test('trial pauses during Premium, resumes at the exact end even with a late login, then expires', () => {
    const s = state(); s.grants = [grant()];
    assert.equal(rights(s, 1).tier, 'trial');
    const active = rights(s, 10);
    assert.equal(active.tier, 'premium'); assert.equal(active.hasTrial, false); assert.equal(active.trialRemainingMs, 5 * DAY_MS);
    assert.equal(active.trialResumesAt, date(32).toISOString()); assert.equal(active.trialEndsAt, date(37).toISOString());
    assert.equal(rights(s, 32).tier, 'trial'); assert.equal(rights(s, 34).trialRemainingMs, 3 * DAY_MS);
    assert.equal(rights(s, 37).tier, 'standard'); assert.equal(rights(s, 100).tier, 'standard');
});
test('renewals stack, repeated evaluation does not extend, and queued refunds preserve other purchases', () => {
    const s = state(); s.grants = [grant(), grant(5, 1, 'B')];
    const before = JSON.stringify(s);
    for (let i = 0; i < 5; i++) assert.equal(rights(s, 10).subscriptionEndsAt, date(33).toISOString());
    assert.equal(JSON.stringify(s), before);
    s.grants[1].revokedAt = date(6);
    assert.equal(rights(s, 10).subscriptionEndsAt, date(32).toISOString());
    assert.equal(rights(s, 32).trialEndsAt, date(37).toISOString());
});
test('refunding an active purchase moves the queued surviving purchase forward without duplicating trial', () => {
    const s = state(); s.grants = [{ ...grant(), revokedAt: date(10) }, grant(5, 1, 'B')];
    assert.equal(rights(s, 10).subscriptionEndsAt, date(11).toISOString());
    assert.equal(rights(s, 11).tier, 'trial'); assert.equal(rights(s, 11).trialEndsAt, date(16).toISOString());
    s.grants[1].revokedAt = date(10.5);
    assert.equal(rights(s, 10.5).trialEndsAt, date(15.5).toISOString());
});
test('referrals during Premium are saved, expired trials can restart from new credits only', () => {
    const s = state(); s.grants = [grant()]; s.trialCredits = [{ at: date(15), durationMs: 7 * DAY_MS }];
    assert.equal(rights(s, 10).trialRemainingMs, 5 * DAY_MS);
    assert.equal(rights(s, 16).trialRemainingMs, 12 * DAY_MS); assert.equal(rights(s, 32).trialEndsAt, date(44).toISOString());
    s.grants = []; s.trialCredits = [{ at: date(20), durationMs: 7 * DAY_MS }];
    assert.equal(rights(s, 19).tier, 'standard'); assert.equal(rights(s, 20).trialEndsAt, date(27).toISOString());
});
test('separate paid periods consume trial only in the gap; out-of-order receipts replay deterministically', () => {
    const s = state(); s.grants = [grant(5, 1, 'B'), grant(2, 1, 'A')];
    assert.equal(rights(s, 6).trialRemainingMs, 3 * DAY_MS); assert.equal(rights(s, 6).trialEndsAt, date(9).toISOString());
    assert.equal(paidMembershipWindows(s.grants).length, 2);
});
test('legacy/foreign/disabled/production sandbox rights fail closed; VIP/admin rights stay intact', () => {
    const s = state(); s.grants = [grant()];
    assert.equal(sandboxMembershipAllowed({ NODE_ENV: 'production', PAYPAL_MEMBERSHIP_ENABLED: 'true' }), false);
    assert.equal(sandboxMembershipAllowed({ NODE_ENV: 'development' }), false);
    assert.equal(sandboxMembershipAllowed({ NODE_ENV: 'development', PAYPAL_MEMBERSHIP_ENABLED: 'true' }), true);
    for (const change of [{ version: 0 }, { environment: 'live' }, { baselineAt: date(100) }])
        assert.equal(evaluatePaidMembership({ ...s, ...change }, date(10)), null);
    assert.equal(evaluateMembership({ billingMembership: s }, date(10), { allowSandboxMembership: false }).tier, 'standard');
    assert.equal(evaluateMembership({ billingMembership: s, vip: { enabled: true } }, date(10), { allowSandboxMembership: true }).tier, 'vip');
    assert.equal(evaluateMembership({ billingMembership: s, isAdmin: true }, date(10), { allowSandboxMembership: true }).tier, 'admin');
});
