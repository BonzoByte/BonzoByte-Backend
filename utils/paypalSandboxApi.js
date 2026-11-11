const ROOT = 'https://api-m.sandbox.paypal.com';
export const billingError = (code, status = 502) => Object.assign(new Error(code), { code, status });
export const paypalId = value => typeof value === 'string' && /^[A-Z0-9]{10,32}$/.test(value);

// No caller-controlled hosts, redirects, endpoints or live-mode switch.
export function createPaypalSandboxApi({ clientId, secret, webhookId, fetchImpl = fetch }) {
    async function request(path, method = 'GET', body, requestId, rawBody) {
        if (!clientId || !secret) throw billingError('PAYPAL_NOT_CONFIGURED', 503);
        if (!/^\/v2\/(checkout\/orders|payments\/(captures|refunds))(\/[A-Z0-9]{10,32})?(\/(capture|refund))?$/.test(path)
            && path !== '/v1/notifications/verify-webhook-signature') throw billingError('INVALID_PAYPAL_PATH', 400);
        const tokenResponse = await fetchImpl(ROOT + '/v1/oauth2/token', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
            headers: { Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
        });
        if (!tokenResponse.ok) throw billingError('PAYPAL_UNAVAILABLE');
        const token = await tokenResponse.json();
        if (!token.access_token) throw billingError('PAYPAL_UNAVAILABLE');
        const response = await fetchImpl(ROOT + path, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
            headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json',
                Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
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
        request,
        async verifyWebhook(raw, headers) {
            if (!webhookId || webhookId === 'WEBHOOK_ID') throw billingError('WEBHOOK_NOT_CONFIGURED', 503);
            if (!Buffer.isBuffer(raw) || raw.length > 262144) throw billingError('INVALID_WEBHOOK', 400);
            const fields = { transmission_id: headers['paypal-transmission-id'], transmission_time: headers['paypal-transmission-time'],
                cert_url: headers['paypal-cert-url'], auth_algo: headers['paypal-auth-algo'], transmission_sig: headers['paypal-transmission-sig'] };
            if (Object.values(fields).some(value => typeof value !== 'string' || !value.length || value.length > 2048)
                || fields.auth_algo !== 'SHA256withRSA' || !Number.isFinite(Date.parse(fields.transmission_time)))
                throw billingError('INVALID_WEBHOOK', 400);
            let cert;
            try { cert = new URL(fields.cert_url); } catch { throw billingError('INVALID_WEBHOOK', 400); }
            if (cert.protocol !== 'https:' || !['api.paypal.com', 'api-m.paypal.com', 'api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(cert.hostname)
                || cert.username || cert.password || cert.port || cert.search || cert.hash
                || !/^\/v1\/notifications\/certs\/[A-Za-z0-9-]+$/.test(cert.pathname)) throw billingError('INVALID_WEBHOOK', 400);
            let event;
            try { event = JSON.parse(raw.toString('utf8')); } catch { throw billingError('INVALID_WEBHOOK', 400); }
            if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9-]{5,128}$/.test(event.id)
                || typeof event.event_type !== 'string') throw billingError('INVALID_WEBHOOK', 400);
            // Preserve the original event JSON bytes in the postback verification envelope.
            const prefix = JSON.stringify({ ...fields, webhook_id: webhookId });
            const body = prefix.slice(0, -1) + ',"webhook_event":' + raw.toString('utf8') + '}';
            const checked = await request('/v1/notifications/verify-webhook-signature', 'POST', undefined, undefined, body);
            if (checked.verification_status !== 'SUCCESS') throw billingError('INVALID_WEBHOOK_SIGNATURE', 400);
            return event;
        },
    };
}
