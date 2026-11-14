import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateMembership } from '../utils/membership.js';
import { createInitialTrial, grantInitialTrialIfMissing } from '../utils/trial.js';

const start = new Date('2026-09-01T12:00:00Z');
const trial = createInitialTrial(start);
const during = new Date('2026-09-03T00:00:00Z');
const after = new Date('2026-09-10T12:00:00Z');

test('registration grants exactly seven days and expires at the boundary', () => {
    assert.equal(trial.endsAt.getTime() - start.getTime(), 7 * 86400000);
    assert.equal(evaluateMembership({ trial }, new Date(trial.endsAt.getTime() - 1)).tier, 'trial');
    const expired = evaluateMembership({ trial }, trial.endsAt);
    assert.equal(expired.tier, 'standard');
    assert.equal(expired.showAds, true);
    assert.equal(expired.hasTrial, false);
    assert.equal(expired.membershipEndsAt, null);
});
test('archive clocks cannot prolong a trial or subscription', () => {
    const old = process.env.NOW_OVERRIDE_ISO;
    process.env.NOW_OVERRIDE_ISO = '1990-01-01T00:00:00Z';
    try {
        assert.equal(evaluateMembership({ trial }, after).showAds, true);
        assert.equal(evaluateMembership({ trial: { endsAt: '2000-01-01' } }).hasTrial, false);
    } finally {
        if (old === undefined) delete process.env.NOW_OVERRIDE_ISO;
        else process.env.NOW_OVERRIDE_ISO = old;
    }
});
test('existing and legacy accounts never receive another trial through the compatibility helper', () => {
    for (const user of [{ isNew: false }, { isNew: false, trial }, { isNew: false, trial: { endsAt: null } },
        { isNew: true, trial: { grantedDaysTotal: 7 } }, { isNew: true, trial: { lastGrantedAt: start } }]) {
        const before = JSON.stringify(user);
        assert.equal(grantInitialTrialIfMissing(user), false);
        assert.equal(JSON.stringify(user), before);
    }
    const fresh = { isNew: true };
    assert.equal(grantInitialTrialIfMissing(fresh), true);
    assert.equal(grantInitialTrialIfMissing(fresh), false);
});
test('invalid/future trial dates and missing old trial metadata fail closed', () => {
    for (const value of [undefined, { endsAt: null }, { endsAt: 'bad' },
        { startedAt: '2027-01-01', endsAt: '2027-01-08' }, { startedAt: 'bad', endsAt: '2027-01-08' }])
        assert.equal(evaluateMembership({ trial: value }, during).hasTrial, false);
});
test('Premium is time limited even if stored plan remains premium', () => {
    const user = { plan: 'premium', subscription: { status: 'active', validUntil: trial.endsAt } };
    assert.equal(evaluateMembership(user, during).tier, 'premium');
    assert.equal(evaluateMembership(user, trial.endsAt).tier, 'standard');
    assert.equal(evaluateMembership({ plan: 'premium' }, during).isPremium, false);
    for (const status of ['none', 'expired', 'past_due', 'canceled'])
        assert.equal(evaluateMembership({ subscription: { status, validUntil: '2027-01-01' } }, during).isPremium, false);
});
test('manual VIP does not require or grant administrator rights', () => {
    const user = { isAdmin: false, vip: { enabled: true, source: 'manual' } };
    const access = evaluateMembership(user, after);
    assert.equal(access.tier, 'vip');
    assert.equal(access.isPremium, true);
    assert.equal(access.isLifetime, true);
    assert.equal(access.showAds, false);
    assert.equal(user.isAdmin, false);
    assert.equal(evaluateMembership({ vip: { enabled: false } }, after).tier, 'standard');
});
test('active lifetime Founders membership is VIP, and revocation is respected', () => {
    const subscription = { provider: 'paypal', status: 'active', isLifetime: true };
    assert.equal(evaluateMembership({ subscription }, after).tier, 'vip');
    assert.equal(evaluateMembership({ subscription }, after).membershipEndsAt, null);
    assert.equal(evaluateMembership({ subscription: { ...subscription, status: 'canceled' } }, after).tier, 'standard');
});
test('expired trial/premium ad metadata cannot permanently suppress ads', () => {
    for (const disabledReason of ['trial', 'premium'])
        assert.equal(evaluateMembership({ trial, ads: { enabled: false, disabledReason } }, after).showAds, true);
    assert.equal(evaluateMembership({ ads: { enabled: false, disabledReason: 'manual' } }, after).showAds, false);
});
test('precedence and refresh deadline preserve surviving rights', () => {
    const user = { trial, subscription: { status: 'active', validUntil: '2026-09-04T00:00:00Z' } };
    assert.equal(evaluateMembership(user, during).tier, 'premium');
    assert.equal(evaluateMembership(user, during).nextChangeAt, '2026-09-04T00:00:00.000Z');
    assert.equal(evaluateMembership(user, new Date('2026-09-05')).tier, 'trial');
    assert.equal(evaluateMembership({ ...user, isAdmin: true }, after).tier, 'admin');
});
test('manual and OAuth registration share one initializer; existing OAuth links do not grant trials', async () => {
    const passport = await readFile(new URL('../config/passport.js', import.meta.url), 'utf8');
    const controller = await readFile(new URL('../controllers/auth.controller.js', import.meta.url), 'utf8');
    assert.equal((passport.match(/trial: createInitialTrial\(\)/g) || []).length, 2);
    assert.equal((controller.match(/createInitialTrial\(\)/g) || []).length, 1);
    assert.match(controller, /trial: assertBillingLabEnvironment\(\) \? \{\} : createInitialTrial\(\)/);
    assert.ok(!passport.includes('grantInitialTrialIfMissing'));
});
