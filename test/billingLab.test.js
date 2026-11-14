import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBillingLabEnvironment, assertBillingLabDatabase, BILLING_LAB_DB } from '../utils/billingLabSafety.js';
import { createPaypalSandboxApi } from '../utils/paypalSandboxApi.js';
import { verifiedLabOrder, verifiedLabCapture, createBillingLab } from '../utils/billingLab.js';

const payment = { _id: 'local', orderId: 'ORDER123456789', merchantId: 'MERCHANT12345', amount: '0.01', currency: 'EUR' };
const order = () => ({ id: payment.orderId, status: 'COMPLETED', purchase_units: [{ custom_id: 'local',
    amount: { value: '0.01', currency_code: 'EUR' }, payee: { merchant_id: payment.merchantId },
    payments: { captures: [{ id: 'CAPTURE1234567' }] } }] });
const capture = () => ({ id: 'CAPTURE1234567', status: 'COMPLETED', amount: { value: '0.01', currency_code: 'EUR' },
    payee: { merchant_id: payment.merchantId }, supplementary_data: { related_ids: { order_id: payment.orderId } } });
const headers = { 'paypal-transmission-id': 'fake-transmission', 'paypal-transmission-time': new Date().toISOString(),
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
    'paypal-transmission-sig': 'fake-signature' };

test('lab is off by default; a switch alone cannot enable it in the regular database or production', () => {
    assert.equal(assertBillingLabEnvironment({}), false);
    const valid = { BILLING_LAB_ENABLED: 'true', NODE_ENV: 'development', MONGO_DB: BILLING_LAB_DB,
        PAYPAL_SANDBOX_ENABLED: 'true', BILLING_LAB_AUTH_ISOLATED: 'true', EMAIL_DISABLED: '1', REFERRALS_ENABLED: 'false' };
    assert.equal(assertBillingLabEnvironment(valid), true);
    for (const change of [{ NODE_ENV: 'production' }, { MONGO_DB: 'test' }, { EMAIL_DISABLED: '0' },
        { REFERRALS_ENABLED: 'true' }, { PAYPAL_SANDBOX_ENABLED: 'false' }, { BILLING_LAB_AUTH_ISOLATED: 'false' }])
        assert.throws(() => assertBillingLabEnvironment({ ...valid, ...change }));
    assert.throws(() => assertBillingLabDatabase({ name: 'test' }));
});
test('all lab operations fail before repository access in the wrong database', async () => {
    const trap = new Proxy({}, { get() { assert.fail('Repository must not be accessed'); } });
    const lab = createBillingLab({ connection: { name: 'test' }, Payment: trap, Event: trap, User: trap, api: trap });
    const user = { _id: 'user', isVerified: true };
    for (const call of [() => lab.status(user), () => lab.create(user, 'monthly', 'id'),
        () => lab.capture(user, payment.orderId), () => lab.refund(user, payment.orderId),
        () => lab.reconcile(user, payment.orderId), () => lab.webhook(Buffer.from('{}'), {}), () => lab.reconcileDue()])
        await assert.rejects(call, /BILLING_LAB_DATABASE_REQUIRED/);
});
test('provider evidence binds order, merchant, local reference, exact amount, currency and capture', () => {
    assert.equal(verifiedLabOrder(order(), payment).id, 'CAPTURE1234567');
    assert.equal(verifiedLabCapture(capture(), payment, 'CAPTURE1234567').status, 'COMPLETED');
    for (const mutate of [o => o.id = 'OTHER123456789', o => o.purchase_units.push({}),
        o => o.purchase_units[0].custom_id = 'other', o => o.purchase_units[0].amount.value = '10.00',
        o => o.purchase_units[0].amount.currency_code = 'USD', o => o.purchase_units[0].payee.merchant_id = 'OTHER',
        o => o.purchase_units[0].payments.captures.push({ id: 'OTHER123456789' })]) {
        const value = order(); mutate(value); assert.throws(() => verifiedLabOrder(value, payment), { code: 'PAYMENT_MISMATCH' });
    }
    for (const mutate of [c => c.id = 'OTHER123456789', c => c.amount.value = '0.02', c => c.amount.currency_code = 'USD',
        c => c.payee.merchant_id = 'OTHER', c => c.supplementary_data.related_ids.order_id = 'OTHER123456789',
        c => c.status = 'UNKNOWN']) {
        const value = capture(); mutate(value); assert.throws(() => verifiedLabCapture(value, payment, 'CAPTURE1234567'));
    }
});
test('webhook postback preserves raw event JSON and uses only fixed sandbox endpoints without redirects', async () => {
    const raw = Buffer.from('{ "id": "WH-123456789", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": { "value": 1.00 } }');
    const calls = [];
    const api = createPaypalSandboxApi({ clientId: 'fake', secret: 'fake', webhookId: 'WHCONFIG12345',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            assert.ok(url.startsWith('https://api-m.sandbox.paypal.com/')); assert.equal(options.redirect, 'error');
            return { ok: true, json: async () => url.endsWith('/token') ? { access_token: 'fake' } : { verification_status: 'SUCCESS' } };
        } });
    assert.equal((await api.verifyWebhook(raw, headers)).id, 'WH-123456789');
    assert.ok(calls[1].options.body.endsWith('"webhook_event":' + raw.toString() + '}'));
    assert.equal(JSON.parse(calls[1].options.body).webhook_id, 'WHCONFIG12345');
    await assert.rejects(api.request('https://api-m.paypal.com/v2/checkout/orders'), { code: 'INVALID_PAYPAL_PATH' });
    assert.equal(calls.length, 2);
});
test('unconfigured webhooks, invalid signatures, algorithms, certificate URLs and malformed bodies are rejected', async () => {
    let calls = 0;
    const config = { clientId: 'fake', secret: 'fake', webhookId: 'WHCONFIG12345', fetchImpl: async url => {
        calls++; return { ok: true, json: async () => url.endsWith('/token') ? { access_token: 'fake' } : { verification_status: 'FAILURE' } };
    } };
    const api = createPaypalSandboxApi(config), raw = Buffer.from('{"id":"WH-123456789","event_type":"PAYMENT.CAPTURE.COMPLETED"}');
    for (const url of ['http://api.sandbox.paypal.com/v1/notifications/certs/A', 'https://evil.test/cert',
        'https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/A', 'https://user@api.sandbox.paypal.com/v1/notifications/certs/A',
        'https://api.sandbox.paypal.com/v1/notifications/certs/A?redirect=evil'])
        await assert.rejects(api.verifyWebhook(raw, { ...headers, 'paypal-cert-url': url }), { code: 'INVALID_WEBHOOK' });
    await assert.rejects(api.verifyWebhook(raw, { ...headers, 'paypal-auth-algo': 'none' }), { code: 'INVALID_WEBHOOK' });
    await assert.rejects(api.verifyWebhook(Buffer.from('{oops'), headers), { code: 'INVALID_WEBHOOK' });
    await assert.rejects(createPaypalSandboxApi({ ...config, webhookId: '' }).verifyWebhook(raw, headers), { code: 'WEBHOOK_NOT_CONFIGURED' });
    await assert.rejects(createPaypalSandboxApi({ ...config, webhookId: 'WEBHOOK_ID' }).verifyWebhook(raw, headers), { code: 'WEBHOOK_NOT_CONFIGURED' });
    assert.equal(calls, 0);
    await assert.rejects(api.verifyWebhook(raw, headers), { code: 'INVALID_WEBHOOK_SIGNATURE' });
    assert.equal(calls, 2);
});
