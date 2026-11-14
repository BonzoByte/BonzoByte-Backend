import { billingError } from './paypalSandboxApi.js';

const ROOT = 'https://api-m.paypal.com';
const LIVE_CERT_HOSTS = new Set(['api.paypal.com', 'api-m.paypal.com']);
const id = '[A-Z0-9]{10,32}';
const readPath = new RegExp(`^/v2/(checkout/orders|payments/(captures|refunds))/${id}$`);
const financialPath = new RegExp(`^/v2/(checkout/orders(?:/${id}/capture)?|payments/captures/${id}/refund)$`);

// Deliberately separate from the Sandbox client. No caller-controlled host or
// auto-retry. Construction performs no I/O; the guarded Live runtime must
// explicitly enable each instance.
export function createPaypalLiveApi({ enabled = false, clientId, secret, webhookId, fetchImpl = fetch } = {}) {
    const requireReady = () => {
        if (enabled !== true || !clientId || !secret) throw billingError('PAYPAL_LIVE_NOT_CONFIGURED', 503);
    };
    async function request(path, method = 'GET', body, requestId, rawBody) {
        requireReady();
        const verification = path === '/v1/notifications/verify-webhook-signature' && method === 'POST';
        const financial = method === 'POST' && financialPath.test(path);
        if (!(method === 'GET' && readPath.test(path)) && !verification && !financial)
            throw billingError('INVALID_PAYPAL_PATH', 400);
        if (financial && (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,38}$/.test(requestId)))
            throw billingError('PAYPAL_REQUEST_ID_REQUIRED', 400);
        const authenticated = await fetchImpl(ROOT + '/v1/oauth2/token', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
        });
        if (!authenticated.ok) throw billingError('PAYPAL_UNAVAILABLE');
        const token = await authenticated.json();
        if (typeof token.access_token !== 'string' || !token.access_token.length) throw billingError('PAYPAL_UNAVAILABLE');
        const response = await fetchImpl(ROOT + path, {
            method, redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json',
                Prefer: 'return=representation', ...(financial ? { 'PayPal-Request-Id': requestId } : {}) },
            ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const data = await response.json();
        if (!response.ok) {
            const issue = data?.details?.[0]?.issue;
            throw billingError(['INSTRUMENT_DECLINED', 'ORDER_ALREADY_CAPTURED', 'CAPTURE_FULLY_REFUNDED'].includes(issue)
                ? issue : 'PAYPAL_UNAVAILABLE');
        }
        return data;
    }
    return {
        environment: 'live', request,
        async verifyWebhook(raw, headers) {
            requireReady();
            if (typeof webhookId !== 'string' || !/^[A-Z0-9]{5,128}$/.test(webhookId) || webhookId === 'WEBHOOK_ID')
                throw billingError('WEBHOOK_NOT_CONFIGURED', 503);
            if (!Buffer.isBuffer(raw) || raw.length > 262144) throw billingError('INVALID_WEBHOOK', 400);
            const fields = { transmission_id: headers['paypal-transmission-id'], transmission_time: headers['paypal-transmission-time'],
                cert_url: headers['paypal-cert-url'], auth_algo: headers['paypal-auth-algo'], transmission_sig: headers['paypal-transmission-sig'] };
            if (Object.values(fields).some(value => typeof value !== 'string' || !value.length || value.length > 2048)
                || fields.auth_algo !== 'SHA256withRSA' || !Number.isFinite(Date.parse(fields.transmission_time)))
                throw billingError('INVALID_WEBHOOK', 400);
            let cert;
            try { cert = new URL(fields.cert_url); } catch { throw billingError('INVALID_WEBHOOK', 400); }
            if (cert.protocol !== 'https:' || !LIVE_CERT_HOSTS.has(cert.hostname) || cert.username || cert.password
                || cert.port || cert.search || cert.hash || !/^\/v1\/notifications\/certs\/[A-Za-z0-9-]+$/.test(cert.pathname))
                throw billingError('INVALID_WEBHOOK', 400);
            let event;
            try { event = JSON.parse(raw.toString('utf8')); } catch { throw billingError('INVALID_WEBHOOK', 400); }
            if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9-]{5,128}$/.test(event.id)
                || typeof event.event_type !== 'string') throw billingError('INVALID_WEBHOOK', 400);
            const prefix = JSON.stringify({ ...fields, webhook_id: webhookId });
            const envelope = prefix.slice(0, -1) + ',"webhook_event":' + raw.toString('utf8') + '}';
            const result = await request('/v1/notifications/verify-webhook-signature', 'POST', undefined, undefined, envelope);
            if (result.verification_status !== 'SUCCESS') throw billingError('INVALID_WEBHOOK_SIGNATURE', 400);
            return event;
        },
    };
}
