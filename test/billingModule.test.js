import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingModule } from '../utils/billingModule.js';

const config = { enabled: true, nodeEnv: 'test', clientId: 'public-test', secret: 'private-test' };
const user = { _id: 'test-user', isVerified: true };
const fixture = (mode = 'preview-only', settings = config) => {
    const calls = [];
    const adapter = {};
    for (const action of ['create', 'capture', 'status', 'reconcile', 'refund']) {
        adapter[action] = async (...args) => { calls.push({ action, args }); return { sandbox: true, fulfillment: mode, payments: [] }; };
    }
    const denied = new Proxy({}, { get() { assert.fail('Wrong environment adapter accessed'); } });
    const preview = { status: async () => ({ realMembershipChanged: false }), start: async () => ({ realMembershipChanged: false }) };
    return { calls, adapter, billing: createBillingModule({ config: settings, checkout: mode === 'preview-only' ? adapter : denied,
        membershipPreview: mode === 'preview-only' ? preview : denied, lab: mode === 'isolated-lab' ? adapter : null,
        plans: mode === 'sandbox-plans' ? adapter : null, webhookConfigured: true }) };
};

test('one contract selects only the configured adapter and never exposes secrets or Live capabilities', async () => {
    for (const mode of ['preview-only', 'isolated-lab']) {
        const { billing, calls } = fixture(mode);
        const publicConfig = billing.config();
        assert.equal(publicConfig.protocolVersion, 1);
        assert.equal(publicConfig.fulfillment, mode);
        assert.equal(publicConfig.capabilities.livePayments, false);
        assert.equal(publicConfig.capabilities.refund, mode === 'isolated-lab');
        assert.equal(publicConfig.capabilities.activatesMembership, mode === 'isolated-lab');
        assert.equal(publicConfig.webhookConfigured, mode === 'isolated-lab');
        assert.equal(JSON.stringify(publicConfig).includes(config.secret), false);
        await billing.create(user, 'monthly', 'request'); await billing.capture(user, 'order');
        const status = await billing.status(user); await billing.reconcile(user, 'order');
        assert.deepEqual(status.capabilities, publicConfig.capabilities);
        assert.deepEqual(calls.map(c => c.action), ['create', 'capture', 'status', 'reconcile']);
        assert.deepEqual(calls[0].args, [user, 'monthly', 'request']);
    }
});
test('normal application denies refunds on the server; lab cannot use the normal membership preview', async () => {
    const main = fixture(), lab = fixture('isolated-lab');
    await assert.rejects(main.billing.refund(user, 'order'), { code: 'BILLING_ACTION_NOT_ALLOWED', status: 403 });
    assert.deepEqual(main.calls, []);
    assert.equal((await main.billing.preview(user)).realMembershipChanged, false);
    assert.equal((await main.billing.preview(user, 'order')).realMembershipChanged, false);
    await assert.rejects(lab.billing.preview(user), { code: 'BILLING_ACTION_NOT_ALLOWED', status: 403 });
    await lab.billing.refund(user, 'order');
    assert.deepEqual(lab.calls.map(c => c.action), ['refund']);
});
test('disabled, production and unverified operations fail before reaching any adapter', async () => {
    for (const mode of ['preview-only', 'isolated-lab']) {
        for (const changed of [{ ...config, enabled: false }, { ...config, nodeEnv: 'production' }, { ...config, secret: '' }, config]) {
            const { billing, calls } = fixture(mode, changed);
            const actor = changed === config ? { ...user, isVerified: false } : user;
            for (const action of ['create', 'capture', 'status', 'reconcile', 'refund', 'preview'])
                await assert.rejects(billing[action](actor, 'anything'), { code: changed === config ? 'VERIFICATION_REQUIRED' : 'PAYPAL_NOT_CONFIGURED' });
            assert.deepEqual(calls, []);
        }
    }
});
test('cross-environment and malformed adapter responses are not presented as payment history', async () => {
    const { billing, adapter } = fixture();
    for (const bad of [{ sandbox: true, fulfillment: 'isolated-lab', payments: [] },
        { sandbox: false, fulfillment: 'preview-only', payments: [] }, { sandbox: true, fulfillment: 'preview-only' }]) {
        adapter.status = async () => bad;
        await assert.rejects(billing.status(user), { code: 'BILLING_ENVIRONMENT_MISMATCH' });
    }
});
test('full sandbox plans have a separate version, real catalog, no Founders or preview, and remain blocked in production', async () => {
    const { billing, calls } = fixture('sandbox-plans');
    const settings = billing.config();
    assert.equal(settings.protocolVersion, 2); assert.equal(settings.fulfillment, 'sandbox-plans');
    assert.equal(settings.amount, null); assert.equal(settings.capabilities.livePayments, false);
    assert.equal(settings.capabilities.activatesMembership, true); assert.equal(settings.capabilities.membershipPreview, false);
    assert.equal(settings.plans.length, 4); assert.deepEqual(settings.plans.find(p => p.key === 'monthly'), { key: 'monthly', amount: '10.00', currency: 'EUR', durationDays: 30 });
    await assert.rejects(billing.preview(user), { code: 'BILLING_ACTION_NOT_ALLOWED' });
    await billing.capture(user, 'order'); await billing.refund(user, 'order');
    assert.deepEqual(calls.map(c => c.action), ['capture', 'refund']);
    const prod = fixture('sandbox-plans', { ...config, nodeEnv: 'production' });
    assert.equal(prod.billing.config().enabled, false);
    await assert.rejects(prod.billing.capture(user, 'order'), { code: 'PAYPAL_NOT_CONFIGURED' });
});
