import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingModule } from '../utils/billingModule.js';
import { createBillingLab } from '../utils/billingLab.js';
import { evaluateMembership } from '../utils/membership.js';
import { DAY_MS } from '../utils/paidMembership.js';
import LivePayment from '../models/livePayment.model.js';
import LiveEmail from '../models/liveBillingEmail.model.js';
import { createDeletionCleanup } from '../utils/accountDeletionCleanup.js';
import { requireLiveBilling, requireLiveBillingDatabase } from '../utils/liveBillingSafety.js';
import { BILLING_LAB_DB } from '../utils/billingLabSafety.js';

const user = { _id: 'fixture-user', isVerified: true };
const context = { environment: 'live', protocolVersion: 3 };
test('Live setup rejects missing keys/webhook, test database and mixed Sandbox flags', () => {
    const base = { enabled: true, clientId: 'fake', secret: 'fake', webhookId: 'FIXTUREWEBHOOK123', database: 'BonzoByte_Beta' };
    assert.doesNotThrow(() => requireLiveBilling(base));
    for (const patch of [{ enabled: false }, { sandboxEnabled: true }, { sandboxPlansEnabled: true }, { labEnabled: true },
        { archivesOnly: true }, { clientId: '' }, { secret: '' }, { webhookId: '' }, { webhookId: 'WEBHOOK_ID' }, { database: BILLING_LAB_DB }])
        assert.throws(() => requireLiveBilling({ ...base, ...patch }), { code: 'LIVE_BILLING_ENVIRONMENT_REQUIRED' });
    assert.throws(() => requireLiveBillingDatabase({ name: BILLING_LAB_DB, db: {}, readyState: 1 }), { code: 'LIVE_BILLING_DATABASE_REQUIRED' });
});
const fixture = (overrides = {}) => {
    const calls = [];
    const live = Object.fromEntries(['create', 'capture', 'status', 'reconcile', 'refund'].map(action => [action, async () => {
        calls.push(action); return { sandbox: false, fulfillment: 'live-plans', payments: [] };
    }]));
    const billing = createBillingModule({ config: { enabled: true, environment: 'live', clientId: 'public', secret: 'never-exposed' },
        live, webhookConfigured: true, ...overrides });
    return { calls, live, billing };
};
test('Live requires explicit mode acknowledgement before creating or capturing; old clients cannot charge', async () => {
    const { calls, billing } = fixture();
    for (const ctx of [undefined, {}, { environment: 'sandbox', protocolVersion: 3 }, { ...context, protocolVersion: 2 }]) {
        await assert.rejects(billing.create(user, 'daily', 'id', ctx), { code: 'BILLING_CLIENT_UPDATE_REQUIRED' });
        await assert.rejects(billing.capture(user, 'id', ctx), { code: 'BILLING_CLIENT_UPDATE_REQUIRED' });
    }
    assert.deepEqual(calls, []);
    await billing.create(user, 'daily', 'id', context); await billing.capture(user, 'id', context);
    assert.deepEqual(calls, ['create', 'capture']);
});
test('Live contract is explicit, EUR only, no preview, client refunds or exposed secret; webhook mandatory', async () => {
    const { billing, calls } = fixture(), c = billing.config();
    assert.equal(c.sandbox, false); assert.equal(c.protocolVersion, 3); assert.equal(c.capabilities.livePayments, true);
    assert.equal(c.capabilities.refund, false); assert.equal(c.capabilities.membershipPreview, false);
    assert.equal(c.plans.length, 4); assert.equal(c.currency, 'EUR');
    assert.equal(JSON.stringify(c).includes('never-exposed'), false);
    await assert.rejects(billing.refund(user, 'id'), { code: 'BILLING_ACTION_NOT_ALLOWED' });
    await assert.rejects(billing.preview(user), { code: 'BILLING_ACTION_NOT_ALLOWED' });
    assert.deepEqual(calls, []);
    assert.equal(fixture({ webhookConfigured: false }).billing.config().enabled, false);
    await assert.rejects(fixture({ webhookConfigured: false }).billing.create(user, 'daily', 'id', context), { code: 'PAYPAL_NOT_CONFIGURED' });
});
test('foreign adapter output and mixed runtime/provider modes are rejected', async () => {
    const { billing, live } = fixture();
    live.status = async () => ({ sandbox: true, fulfillment: 'sandbox-plans', payments: [] });
    await assert.rejects(billing.status(user), { code: 'BILLING_ENVIRONMENT_MISMATCH' });
    assert.throws(() => fixture({ plans: {} }), { code: 'BILLING_ENVIRONMENT_MISMATCH' });
    assert.throws(() => createBillingLab({ planMode: true, liveMode: true, api: { environment: 'sandbox' } }), { code: 'LIVE_BILLING_ENVIRONMENT_REQUIRED' });
});
test('Live membership survives production evaluation; Sandbox grants never extend it; earned time and trial compose', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const base = { version: 1, baselineAt: at, baselineTrialMs: 7 * DAY_MS, trialCredits: [] };
    const account = { trial: { startedAt: at, endsAt: new Date(+at + 7 * DAY_MS) },
        billingMembership: { ...base, environment: 'sandbox', grants: [{ paymentId: 'sandbox', paidAt: at, durationMs: 365 * DAY_MS }] },
        liveBillingMembership: { ...base, environment: 'live', grants: [{ paymentId: 'live', paidAt: at, durationMs: DAY_MS }] },
        earnedMembership: { ...base, environment: 'production', grants: [{ awardId: 'earned', grantedAt: at, durationMs: DAY_MS }] } };
    const r = evaluateMembership(account, at, { allowSandboxMembership: true, rewardEnvironment: 'production' });
    assert.equal(r.tier, 'premium'); assert.equal(r.sandboxMembership, false);
    assert.equal(r.subscriptionEndsAt, new Date(+at + 2 * DAY_MS).toISOString());
    assert.equal(r.trialRemainingMs, 7 * DAY_MS);
    assert.equal(evaluateMembership(account, new Date(+at + 2 * DAY_MS), { rewardEnvironment: 'production' }).tier, 'trial');
    assert.equal(evaluateMembership(account, new Date(+at + 9 * DAY_MS), { rewardEnvironment: 'production' }).tier, 'standard');
});
test('Live schemas reject Sandbox, remove test clock overrides, and deletion retains real financial evidence', async () => {
    assert.equal(LivePayment.collection.collectionName, 'livepayments'); assert.equal(LiveEmail.collection.collectionName, 'livebillingemails');
    assert.equal(LivePayment.schema.path('testDurationMs'), undefined);
    assert.ok(new LivePayment({ environment: 'sandbox' }).validateSync().errors.environment);
    let writes = 0;
    const cleanup = createDeletionCleanup({ collection: name => ({ findOne: async () => name === 'livepayments' ? { _id: 'receipt' } : null,
        deleteMany: async () => { ++writes; } }) });
    await assert.rejects(cleanup.check({ _id: 'fixture' }, new Date()), { code: 'DELETION_RETENTION_REVIEW' });
    assert.equal(writes, 0);
});
