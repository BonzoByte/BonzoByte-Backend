import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaypalLiveApi } from '../utils/paypalLiveApi.js';

const config = { enabled: true, clientId: 'synthetic-live-client', secret: 'synthetic-live-secret', webhookId: '12345678901234567' };
const orderId = 'ABCDEF1234567890';
const raw = Buffer.from('{ "id": "WH-TEST-123456", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {} }');
const headers = { 'paypal-transmission-id': 'synthetic-transmission', 'paypal-transmission-time': '2026-11-14T00:00:00Z',
    'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-123', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': 'synthetic-signature' };
function stub(result = { id: orderId }) {
    const calls = [];
    return { calls, fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => url.endsWith('/token') ? { access_token: 'synthetic-token' } : result };
    } };
}
test('is off by default and constructor never makes network requests', async () => {
    const mock = stub();const api = createPaypalLiveApi({ ...config, enabled: false, fetchImpl: mock.fetchImpl });
    assert.equal(mock.calls.length, 0);
    await assert.rejects(api.request('/v2/checkout/orders', 'POST', {}, 'request-1'), { code: 'PAYPAL_LIVE_NOT_CONFIGURED' });
    assert.equal(mock.calls.length, 0);
});
test('uses only Live hosts and requires an idempotency key for every financial POST', async () => {
    const mock = stub();const api = createPaypalLiveApi({ ...config, fetchImpl: mock.fetchImpl });
    await assert.rejects(api.request('/v2/checkout/orders', 'POST', {}), { code: 'PAYPAL_REQUEST_ID_REQUIRED' });
    assert.equal(mock.calls.length, 0);
    await api.request('/v2/checkout/orders', 'POST', { intent: 'CAPTURE' }, 'request-1');
    assert.ok(mock.calls.every(c => c.url.startsWith('https://api-m.paypal.com/') && c.options.redirect === 'error'));
    assert.equal(mock.calls[1].options.headers['PayPal-Request-Id'], 'request-1');
});
test('rejects arbitrary paths, methods, URLs and webhook mutation before using credentials', async () => {
    const mock = stub();const api = createPaypalLiveApi({ ...config, fetchImpl: mock.fetchImpl });
    for (const [path, method] of [['https://api-m.sandbox.paypal.com/v2/checkout/orders', 'POST'],
        ['/v1/notifications/webhooks', 'POST'], ['/v2/checkout/orders', 'GET'], ['/v2/checkout/orders/'+orderId, 'DELETE'],
        ['/v2/checkout/orders/../orders', 'POST']]) {
        await assert.rejects(api.request(path, method, {}, 'request-1'), { code: 'INVALID_PAYPAL_PATH' });
    }
    assert.equal(mock.calls.length, 0);
});
test('reconciliation GET cannot capture and a failed capture is never automatically retried', async () => {
    const mock = stub();const api = createPaypalLiveApi({ ...config, fetchImpl: mock.fetchImpl });
    await api.request('/v2/checkout/orders/'+orderId);
    assert.equal(mock.calls[1].options.method, 'GET');assert.equal(mock.calls[1].options.headers['PayPal-Request-Id'], undefined);
    let calls = 0;
    const failed = createPaypalLiveApi({ ...config, fetchImpl: async url => {
        calls++;if (url.endsWith('/token')) return { ok: true, json: async () => ({ access_token: 'synthetic' }) };
        throw new Error('Synthetic interrupted request');
    } });
    await assert.rejects(failed.request('/v2/checkout/orders/'+orderId+'/capture', 'POST', {}, 'capture-1'));
    assert.equal(calls, 2);
});
test('rejects Sandbox certificates and a forged signature; preserves original webhook bytes', async () => {
    const mock = stub({ verification_status: 'SUCCESS' });const api = createPaypalLiveApi({ ...config, fetchImpl: mock.fetchImpl });
    for (const host of ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com', 'paypal.com.evil.invalid'])
        await assert.rejects(api.verifyWebhook(raw, { ...headers, 'paypal-cert-url': 'https://'+host+'/v1/notifications/certs/CERT-123' }), { code: 'INVALID_WEBHOOK' });
    assert.equal(mock.calls.length, 0);
    assert.equal((await api.verifyWebhook(raw, headers)).id, 'WH-TEST-123456');
    assert.ok(mock.calls[1].options.body.includes(raw.toString('utf8')));
    assert.equal(mock.calls[1].options.headers['PayPal-Request-Id'], undefined);
    const failed = stub({ verification_status: 'FAILURE' });
    await assert.rejects(createPaypalLiveApi({ ...config, fetchImpl: failed.fetchImpl }).verifyWebhook(raw, headers), { code: 'INVALID_WEBHOOK_SIGNATURE' });
});
test('does not accept simulator webhooks or an incomplete event as Live evidence', async () => {
    const mock = stub();
    await assert.rejects(createPaypalLiveApi({ ...config, webhookId: 'WEBHOOK_ID', fetchImpl: mock.fetchImpl }).verifyWebhook(raw, headers), { code: 'WEBHOOK_NOT_CONFIGURED' });
    await assert.rejects(createPaypalLiveApi({ ...config, fetchImpl: mock.fetchImpl }).verifyWebhook(Buffer.from('{}'), headers), { code: 'INVALID_WEBHOOK' });
    assert.equal(mock.calls.length, 0);
});
