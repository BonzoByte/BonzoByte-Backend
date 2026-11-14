import test from 'node:test';
import assert from 'node:assert/strict';
import { billingEmailContent } from '../utils/billingEmailContent.js';
import { billingEmailFailure, createBillingEmailQueue } from '../utils/billingEmail.js';

const at = new Date('2026-10-04T12:00:00Z');
const payment = { _id: 'payment-id', environment: 'sandbox', notificationVersion: 1, plan: 'monthly', amount: '10.00',
    currency: 'EUR', durationDays: 30, orderId: 'ORDER12345678', status: 'completed', grantStartedAt: at };
const rights = { tier: 'premium', subscriptionEndsAt: '2026-11-03T12:00:00Z', trialRemainingMs: 593269935 };

test('purchase snapshot has truthful sandbox amount, duration, saved trial and no recurring promise', () => {
    const result = billingEmailContent('purchase', payment, rights, at);
    assert.match(result.subject, /sandbox/);
    for (const fragment of ['EUR 10.00', '30 days', 'no automatic renewal', '6 days, 20 hours, 48 minutes', '2026-11-03 12:00:00 UTC'])
        assert.ok(result.text.includes(fragment), fragment);
    assert.match(result.text, /No real money was transferred/);
    assert.match(result.text, /not an invoice/);
});

test('refund snapshot preserves trial and other purchases without asserting the account is always Standard', () => {
    for (const tier of ['trial', 'standard', 'premium']) {
        const result = billingEmailContent('refund', payment, { tier }, at);
        assert.match(result.text, /full refund/);
        assert.match(result.text, /Other purchases and unused trial time are preserved/);
        assert.ok(result.text.includes(tier[0].toUpperCase() + tier.slice(1)));
    }
});

test('late recovery of an already expired purchase does not say the active trial is still paused', () => {
    const result = billingEmailContent('purchase', payment, { tier: 'trial', trialRemainingMs: 86400000 }, at);
    assert.match(result.text, /payment has been confirmed/);
    assert.equal(result.text.includes('Saved trial'), false);
    assert.equal(result.text.includes('Premium end at confirmation'), false);
});

test('renderer escapes interpolated content and rejects unknown billing snapshots', () => {
    const result = billingEmailContent('purchase', { ...payment, orderId: '<img src=x>' }, rights, at);
    assert.equal(result.html.includes('<img'), false);
    assert.match(result.html, /&lt;img src=x&gt;/);
    for (const override of [{ environment: 'unknown' }, { plan: 'founders' }, { amount: 'NaN' }, { currency: 'USD' }])
        assert.throws(() => billingEmailContent('purchase', { ...payment, ...override }, rights, at));
});
test('Live confirmation describes real EUR payment without Sandbox or recurring billing', () => {
    const result = billingEmailContent('purchase', { ...payment, environment: 'live' }, rights, at);
    assert.match(result.text, /EUR 10.00/);
    assert.match(result.text, /no automatic renewal/);
    assert.doesNotMatch(result.text + result.subject, /sandbox|No real money/i);
});

test('retry policy distinguishes ambiguous/transient delivery from permanent or conflicting requests', () => {
    for (const error of [new Error('private details'), { statusCode: 429 }, { statusCode: 503 },
        { statusCode: 409, providerCode: 'concurrent_idempotent_requests' }])
        assert.equal(billingEmailFailure(error, 1).review, false);
    for (const error of [{ statusCode: 403 }, { statusCode: 422 }, { code: 'MAIL_SENDER_CHANGED' },
        { statusCode: 409, providerCode: 'invalid_idempotent_request' }])
        assert.equal(billingEmailFailure(error, 1).review, true);
    assert.deepEqual(billingEmailFailure(new Error('secret'), 10), { review: true, code: 'RETRY_LIMIT' });
});

test('disabled mail and SMTP never claim a queued notification', async () => {
    const Outbox = { findOneAndUpdate: () => assert.fail('queue must remain untouched') };
    for (const config of [{ enabled: false, isConfigured: true, provider: 'resend' },
        { enabled: true, isConfigured: false, provider: 'resend' }, { enabled: true, isConfigured: true, provider: 'smtp' }]) {
        const queue = createBillingEmailQueue({ Outbox, enabled: config.enabled, mailer: config });
        assert.equal((await queue.processDue()).checked, 0);
    }
});

test('no retroactive email, abandoned order, partial refund, reversal or preview receipt is enqueued', async () => {
    const Outbox = { findOne: () => assert.fail('not eligible for email') };
    const queue = createBillingEmailQueue({ Outbox, enabled: true, mailer: {} });
    for (const override of [{ notificationVersion: undefined }, { environment: 'live' },
        { status: 'approved', grantStartedAt: null }, { revokedAt: at, revocationReason: 'refund' },
        { revokedAt: at, revocationReason: 'reversal' }])
        await queue.enqueue({ payment: { ...payment, ...override } });
});

test('enqueue only snapshots data in the supplied transaction and duplicate events keep their original payload', async () => {
    const session = { test: true }; let stored;
    const Outbox = {
        findOne: () => ({ session: async value => { assert.equal(value, session); return stored; } }),
        updateOne: async (filter, update, options) => { assert.equal(options.session, session); stored = update.$setOnInsert; },
    };
    const mailer = { prepareMail: mail => ({ ...mail, from: 'BonzoByte <info@bonzobyte.com>', to: [mail.to] }),
        sendMail: () => assert.fail('no delivery inside transaction') };
    const queue = createBillingEmailQueue({ Outbox, mailer, enabled: true });
    await queue.enqueue({ payment, member: { isVerified: true, email: 'buyer@example.invalid' }, rights, at, session });
    assert.equal(stored.state, 'pending'); assert.equal(stored.payload.replyTo, '');
    assert.deepEqual(stored.payload.to, ['buyer@example.invalid']);
    const original = structuredClone(stored);
    await queue.enqueue({ payment, member: { email: 'changed@example.invalid' }, rights: {}, at, session });
    assert.deepEqual(stored, original);
});

test('queued notification for a closing/deleted account never calls the mail provider', async () => {
    const writes = [], row = { _id: 'synthetic-mail', payment: 'synthetic-payment', attempts: 1,
        firstAttemptAt: at, payload: { toObject: () => assert.fail('no payload read needed') } };
    const Outbox = { findOneAndUpdate: async () => row, updateOne: async (...args) => writes.push(args) };
    const queue = createBillingEmailQueue({ Outbox, enabled: true, now: () => at, logger: { warn() {} },
        mailer: { isConfigured: true, provider: 'resend', sendMail: () => assert.fail('no outbound mail') },
        canSendPayment: async id => { assert.equal(id, row.payment); return false; } });
    assert.deepEqual(await queue.processDue(1), { checked: 1, succeeded: 0, review: 1 });
    assert.equal(writes[0][1].$set.failureCode, 'ACCOUNT_CLOSED');
});
