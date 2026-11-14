// Explicitly opted-in integration test: isolated synthetic collections, fake PayPal, no email.
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dns from 'node:dns';
import mongoose from 'mongoose';
import RealUser from '../models/user.model.js';
import RealPayment from '../models/planPayment.model.js';
import RealEvent from '../models/planPaymentEvent.model.js';
import RealOutbox from '../models/billingEmail.model.js';
import LivePayment from '../models/livePayment.model.js';
import LiveEvent from '../models/livePaymentEvent.model.js';
import LiveOutbox from '../models/liveBillingEmail.model.js';
import { createBillingEmailQueue, BILLING_EMAIL_RETRY_WINDOW_MS } from '../utils/billingEmail.js';
import { createMailTransport } from '../utils/mailTransport.js';
import { createBillingLab } from '../utils/billingLab.js';
import { DAY_MS } from '../utils/paidMembership.js';
import { evaluateMembership } from '../utils/membership.js';
import { referralRewardPipeline } from '../utils/referralPolicy.js';
import { BILLING_LAB_DB } from '../utils/billingLabSafety.js';
if (process.env.RUN_PLAN_BILLING_DB_TESTS !== '1') throw new Error('RUN_PLAN_BILLING_DB_TESTS=1 required');
const liveMode = process.env.TEST_LIVE_BILLING === '1';
const paymentEnvironment = liveMode ? 'live' : 'sandbox';
const ledgerKey = liveMode ? 'liveBillingMembership' : 'billingMembership';
const servers = (process.env.DNS_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);
if (servers.length) dns.setServers(servers);
const prefix = 'codex_plan_' + crypto.randomBytes(8).toString('hex');
const names = ['users', 'payments', 'events', 'emails'].map(s => prefix + '_' + s), created = [];
const connection = mongoose.createConnection(process.env.MONGO_URI, { dbName: BILLING_LAB_DB,
    autoIndex: false, autoCreate: false, maxPoolSize: 3, serverSelectionTimeoutMS: 15000 });
try {
    await connection.asPromise(); assert.equal(connection.name, BILLING_LAB_DB);
    for (const name of names) { await connection.db.createCollection(name); created.push(name); }
    const User = connection.model('PlanTestUser', RealUser.schema.clone(), names[0]);
    const Payment = connection.model('PlanTestPayment', (liveMode ? LivePayment : RealPayment).schema.clone(), names[1]);
    const Event = connection.model('PlanTestEvent', (liveMode ? LiveEvent : RealEvent).schema.clone(), names[2]);
    const Outbox = connection.model('PlanTestEmail', (liveMode ? LiveOutbox : RealOutbox).schema.clone(), names[3]);
    await Promise.all([User.createIndexes(), Payment.createIndexes(), Event.createIndexes(), Outbox.createIndexes()]);
    let at = new Date(); const start = at.getTime();
    const delivered = new Map(), sendCalls = [], mailWarnings = [];
    let loseMailResponse = false;
    const mailer = createMailTransport({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'fake-key-never-used',
        EMAIL_FROM: 'info@example.invalid', EMAIL_FROM_NAME: 'Synthetic test' }, {
        createResendClient: () => ({ emails: { send: async (payload, options) => {
            const key = options.idempotencyKey;
            assert.ok(key); sendCalls.push(key);
            if (delivered.has(key)) assert.deepEqual(delivered.get(key).payload, payload);
            else delivered.set(key, { payload: structuredClone(payload), id: 'fake-mail-' + delivered.size });
            if (loseMailResponse) { loseMailResponse = false; throw new Error('lost fake provider response'); }
            return { data: { id: delivered.get(key).id } };
        } } }),
    });
    const notifications = createBillingEmailQueue({ Outbox, mailer, environment: paymentEnvironment, enabled: true, now: () => at,
        logger: { warn: line => mailWarnings.push(line) } });
    const day = n => new Date(start + n * DAY_MS);
    const buyer = await User.create({ name: 'Plan synthetic', email: 'plan@example.invalid', password: 'synthetic-not-a-real-account',
        isVerified: true, trial: { startedAt: day(0), endsAt: day(7), grantedDaysTotal: 7 }, ads: { enabled: true } });
    if (liveMode) {
        buyer.billingMembership = { version: 1, environment: 'sandbox', baselineAt: day(0), baselineTrialMs: 0,
            grants: [{ paymentId: 'old-sandbox', paidAt: day(0), durationMs: 365 * DAY_MS }] };
        await buyer.save();
    }
    const other = await User.create({ name: 'Untouched', email: 'other@example.invalid', password: 'synthetic-not-a-real-account', isVerified: true });
    const untouched = await User.findById(other._id).lean();
    const orders = new Map(), captures = new Map(), refunds = new Map();
    let serial = 1000000000, captureCalls = 0, refundCalls = 0, lostCapture = false, pendingRefund = false;
    let captureGate, captureEntered;
    const api = {
        environment: paymentEnvironment,
        async verifyWebhook(raw) { return JSON.parse(raw); },
        async request(path, method = 'GET', body) {
            if (path === '/v2/checkout/orders') {
                // Provider time follows this fixture's clock, not the wall clock
                // spent waiting on the network by the isolated integration test.
                await Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(body.purchase_units[0].custom_id) },
                    { $set: { createdAt: at, updatedAt: at } });
                const id = 'ORDER' + ++serial;
                const order = { id, status: 'CREATED', purchase_units: [{ ...body.purchase_units[0], payee: { merchant_id: 'MERCHANT12345' } }] };
                orders.set(id, order); return structuredClone(order);
            }
            const id = path.split('/')[4];
            if (path.endsWith('/capture')) {
                if (captureGate) { captureEntered(); await captureGate; }
                captureCalls++; const order = orders.get(id); order.status = 'COMPLETED';
                const captureId = 'CAPTURE' + id.slice(5);
                order.purchase_units[0].payments = { captures: [{ id: captureId }] };
                captures.set(captureId, { id: captureId, status: 'COMPLETED', create_time: at.toISOString(), update_time: at.toISOString(),
                    amount: order.purchase_units[0].amount, payee: { merchant_id: 'MERCHANT12345' }, supplementary_data: { related_ids: { order_id: id } } });
                if (lostCapture) { lostCapture = false; throw new Error('lost-capture-response'); }
                return structuredClone(order);
            }
            if (path.endsWith('/refund')) {
                refundCalls++; const capture = captures.get(id); capture.update_time = at.toISOString();
                if (!pendingRefund) capture.status = 'REFUNDED';
                const refund = { id: 'REFUND' + ++serial, status: pendingRefund ? 'PENDING' : 'COMPLETED', amount: capture.amount, update_time: at.toISOString() };
                refunds.set(refund.id, refund); return structuredClone(refund);
            }
            if (path.startsWith('/v2/checkout/orders/')) return structuredClone(orders.get(id));
            if (path.startsWith('/v2/payments/captures/')) return structuredClone(captures.get(id));
            if (path.startsWith('/v2/payments/refunds/')) return structuredClone(refunds.get(id));
            throw new Error('Unexpected fake provider request');
        },
    };
    const engine = (notificationQueue = notifications) => createBillingLab({ connection, Payment, Event, User, api, now: () => at, planMode: true, liveMode,
        notifications: notificationQueue, assertPlanEnvironment: () => assert.equal(connection.name, BILLING_LAB_DB) });
    const rights = async user => evaluateMembership(await User.findById(user._id), at, { allowSandboxMembership: !liveMode });
    const requestId = crypto.randomUUID();
    const first = await engine().create(buyer, 'monthly', requestId);
    assert.equal((await engine().create(buyer, 'monthly', requestId)).orderId, first.orderId);
    assert.equal(orders.size, 1); assert.equal(orders.get(first.orderId).purchase_units[0].amount.value, '10.00');
    assert.equal((await rights(buyer)).tier, 'trial');
    assert.equal(await Outbox.countDocuments(), 0, 'an abandoned/created order sends nothing');
    await assert.rejects(engine().capture(other, first.orderId), { code: 'ORDER_NOT_FOUND' });
    await assert.rejects(engine().create(buyer, 'founders', crypto.randomUUID()), { code: 'INVALID_ORDER' });
    at = day(2); lostCapture = true;
    await assert.rejects(engine().capture(buyer, first.orderId), /lost-capture-response/);
    assert.equal((await rights(buyer)).tier, 'trial');
    // A new engine instance recovers after a process restart without POSTing another capture.
    await engine().reconcileDue();
    assert.equal(captureCalls, 1); assert.equal((await rights(buyer)).tier, 'premium');
    assert.equal((await rights(buyer)).subscriptionEndsAt, day(32).toISOString());
    assert.equal((await rights(buyer)).trialEndsAt, day(37).toISOString());
    assert.equal(await Outbox.countDocuments({ kind: 'purchase' }), 1);
    // Concurrent workers + a response lost AFTER acceptance keep the identical
    // key/payload. A subsequent instance can finish without a second email.
    loseMailResponse = true;
    const workers = await Promise.all([notifications.processDue(), notifications.processDue()]);
    assert.equal(workers.reduce((sum, r) => sum + r.checked, 0), 1);
    assert.equal(delivered.size, 1);
    assert.equal((await notifications.processDue()).checked, 0, 'retry backoff');
    at = new Date(at.getTime() + 60001);
    const restartedQueue = createBillingEmailQueue({ Outbox, mailer, environment: paymentEnvironment, enabled: true, now: () => at });
    assert.equal((await restartedQueue.processDue()).succeeded, 1);
    assert.equal(delivered.size, 1); assert.equal(sendCalls.length, 2);
    assert.equal(await Outbox.countDocuments({ state: 'accepted' }), 1);
    await Promise.all(Array.from({ length: 4 }, () => engine().reconcile(buyer, first.orderId)));
    assert.equal((await User.findById(buyer._id))[ledgerKey].grants.length, 1);
    assert.equal((await rights(buyer)).subscriptionEndsAt, day(32).toISOString());
    assert.equal(await Outbox.countDocuments({ kind: 'purchase' }), 1, 'reconciliation never queues duplicates');
    const oldCapture = structuredClone(captures.values().next().value);
    at = day(5);
    const second = await engine().create(buyer, 'daily', crypto.randomUUID());
    const [c1, c2] = await Promise.all([engine().capture(buyer, second.orderId), engine().capture(buyer, second.orderId)]);
    assert.ok(c1.completed || c2.completed); assert.equal(captureCalls, 2);
    assert.equal((await rights(buyer)).subscriptionEndsAt, day(33).toISOString());
    assert.equal(await Outbox.countDocuments({ kind: 'purchase' }), 2);
    assert.match((await Outbox.findOne({ kind: 'purchase', payment: (await Payment.findOne({ orderId: second.orderId }))._id })).payload.text,
        /Premium end at confirmation/);
    const referralId = new mongoose.Types.ObjectId();
    await Promise.all(Array.from({ length: 4 }, () => User.updateOne({ _id: buyer._id, 'referral.rewardedUserIds': { $ne: referralId } }, referralRewardPipeline(referralId, at))));
    assert.equal((await User.findById(buyer._id))[ledgerKey].trialCredits.length, 1);
    assert.equal((await rights(buyer)).trialRemainingMs, 12 * DAY_MS);
    // Queued purchase refund preserves original Premium and all saved referral time.
    await engine().refund(buyer, second.orderId); assert.equal(refundCalls, 1);
    assert.equal(await Outbox.countDocuments({ kind: 'refund' }), 1);
    assert.equal((await rights(buyer)).subscriptionEndsAt, day(32).toISOString());
    await engine().refund(buyer, second.orderId); assert.equal(refundCalls, 1);
    at = day(10); pendingRefund = true;
    await engine().refund(buyer, first.orderId); assert.equal((await rights(buyer)).tier, 'premium');
    assert.equal(await Outbox.countDocuments({ kind: 'refund' }), 1, 'pending refund is not advertised as completed');
    const pending = [...refunds.values()].find(r => r.status === 'PENDING'); pending.status = 'COMPLETED'; pending.update_time = at.toISOString();
    await engine().reconcile(buyer, first.orderId);
    assert.equal(await Outbox.countDocuments({ kind: 'refund' }), 2);
    assert.equal((await rights(buyer)).tier, 'trial'); assert.equal((await rights(buyer)).trialEndsAt, day(22).toISOString());
    // A stale completed provider read cannot undo a refund already recorded locally.
    captures.set(oldCapture.id, oldCapture); await engine().reconcile(buyer, first.orderId);
    assert.equal((await rights(buyer)).tier, 'trial');
    assert.equal(await Outbox.countDocuments({ kind: 'purchase' }), 2);
    at = day(23); assert.equal((await rights(buyer)).tier, 'standard');
    assert.deepEqual(await User.findById(other._id).lean(), untouched);
    const ordinary = { _id: buyer._id, isVerified: false };
    await assert.rejects(engine().create(ordinary, 'daily', crypto.randomUUID()), { code: 'VERIFICATION_REQUIRED' });
    // Wrong totals do not produce membership even if the provider says COMPLETED.
    at = new Date(); pendingRefund = false;
    const wrong = await engine().create(other, 'annual', crypto.randomUUID());
    const beforeWrong = await Outbox.countDocuments();
    orders.get(wrong.orderId).purchase_units[0].amount.value = '0.01';
    await assert.rejects(engine().capture(other, wrong.orderId), { code: 'PAYMENT_MISMATCH' });
    assert.equal((await rights(other)).tier, 'standard');
    assert.equal(await Outbox.countDocuments(), beforeWrong);
    // An in-flight capture blocks a second purchase, survives read-only checks,
    // and an APPROVED notification never starts another charge.
    const pendingBuyer = await User.create({ name: 'Pending synthetic', email: 'pending@example.invalid', password: 'synthetic-only', isVerified: true });
    const inFlight = await engine().create(pendingBuyer, 'daily', crypto.randomUUID());
    let releaseCapture; captureGate = new Promise(resolve => { releaseCapture = resolve; });
    const entered = new Promise(resolve => { captureEntered = resolve; });
    const capturing = engine().capture(pendingBuyer, inFlight.orderId); await entered;
    await assert.rejects(engine().create(pendingBuyer, 'monthly', crypto.randomUUID()), { code: 'PAYMENT_PENDING' });
    assert.equal((await engine().status(pendingBuyer)).payments[0].capturePending, true);
    const approved = Buffer.from(JSON.stringify({ id: 'APPROVED-PLAN-EVENT', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: inFlight.orderId } }));
    const callsBefore = captureCalls;
    await engine().webhook(approved, {}); assert.equal(captureCalls, callsBefore);
    assert.equal(await Outbox.countDocuments(), beforeWrong, 'approval alone sends no confirmation');
    releaseCapture(); await capturing; captureGate = null;
    assert.equal((await engine().status(pendingBuyer)).payments[0].capturePending, false);
    const completed = Buffer.from(JSON.stringify({ id: 'COMPLETED-PLAN-EVENT', event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'CAPTURE' + inFlight.orderId.slice(5), supplementary_data: { related_ids: { order_id: inFlight.orderId } } } }));
    await engine().webhook(completed, {});
    assert.equal((await engine().webhook(completed, {})).duplicate, true);
    assert.equal((await User.findById(pendingBuyer._id))[ledgerKey].grants.length, 1);
    const pendingPayment = await Payment.findOne({ orderId: inFlight.orderId });
    assert.equal(await Outbox.countDocuments({ payment: pendingPayment._id }), 1);

    // Notification intents and membership roll back together; a verified capture
    // is recovered later, with no email/provider calls inside the transaction.
    const rollbackBuyer = await User.create({ name: 'Rollback', email: 'rollback@example.invalid', password: 'synthetic-only', isVerified: true });
    const rollback = await engine().create(rollbackBuyer, 'daily', crypto.randomUUID());
    const rollbackRow = await Payment.findOne({ orderId: rollback.orderId });
    const brokenQueue = { ...notifications, enqueue: async args => {
        await notifications.enqueue(args); throw new Error('synthetic transaction abort');
    } };
    await assert.rejects(engine(brokenQueue).capture(rollbackBuyer, rollback.orderId), /synthetic transaction abort/);
    assert.equal((await rights(rollbackBuyer)).tier, 'standard');
    assert.equal(await Outbox.countDocuments({ payment: rollbackRow._id }), 0);
    await engine().reconcile(rollbackBuyer, rollback.orderId);
    assert.equal((await rights(rollbackBuyer)).tier, 'premium');
    assert.equal(await Outbox.countDocuments({ payment: rollbackRow._id }), 1);

    // Enabling notifications never upgrades an older order's missing marker.
    const legacy = await engine(null).create(rollbackBuyer, 'daily', crypto.randomUUID());
    await engine().capture(rollbackBuyer, legacy.orderId);
    const legacyRow = await Payment.findOne({ orderId: legacy.orderId });
    assert.equal(legacyRow.notificationVersion, undefined);
    assert.equal(await Outbox.countDocuments({ payment: legacyRow._id }), 0);

    // Synthetic stuck worker: after lease expiry the queue recovers. If the
    // provider's idempotency window has elapsed it stops for manual review.
    const snapshot = (await Outbox.findOne({ state: 'pending' })).payload.toObject();
    await Outbox.updateMany({ state: 'pending' }, { $set: { state: 'review' } });
    const stalled = await Outbox.create({ payment: new mongoose.Types.ObjectId(), kind: 'purchase', environment: paymentEnvironment,
        idempotencyKey: 'synthetic/stalled', payload: snapshot, state: 'sending', attempts: 1,
        leaseUntil: new Date(at.getTime() - 1), firstAttemptAt: new Date(at.getTime() - 180000) });
    assert.equal((await notifications.processDue()).succeeded, 1);
    assert.equal((await Outbox.findById(stalled._id)).state, 'accepted');
    const expired = await Outbox.create({ payment: new mongoose.Types.ObjectId(), kind: 'refund', environment: paymentEnvironment,
        idempotencyKey: 'synthetic/expired', payload: snapshot, state: 'sending', attempts: 1,
        leaseUntil: new Date(at.getTime() - 1), firstAttemptAt: new Date(at.getTime() - BILLING_EMAIL_RETRY_WINDOW_MS) });
    const sentBeforeExpired = sendCalls.length;
    assert.equal((await notifications.processDue()).review, 1);
    assert.equal(sendCalls.length, sentBeforeExpired);
    assert.equal((await Outbox.findById(expired._id)).failureCode, 'IDEMPOTENCY_WINDOW_EXPIRED');
    assert.equal(mailWarnings.length, 1);
    assert.equal(mailWarnings.some(line => line.includes('@') || line.includes('fake-key')), false);
    if (liveMode) {
        assert.equal((await User.findById(buyer._id)).billingMembership.grants[0].paymentId, 'old-sandbox');
        assert.equal(await Payment.countDocuments({ environment: { $ne: 'live' } }), 0);
        assert.equal(await Outbox.countDocuments({ environment: { $ne: 'live' } }), 0);
        assert.doesNotMatch((await Outbox.findOne({ kind: 'purchase' })).payload.text, /sandbox|No real money/i);
    }
    console.log('PASS mode=' + paymentEnvironment + ': full plan prices/durations, saved trial/referrals, replay/concurrency, restart recovery, refunds, owner/amount checks, pending capture gate and webhook dedup.');
    console.log('PASS: transactional email queue, no historical/abandoned/pending/invalid-payment emails, concurrent workers, exact-payload retry, crash recovery and bounded idempotency. Fake email provider only.');
} finally {
    // Only exact random collections created by this run; never normal or historical data.
    if (connection.readyState === 1 && connection.name === BILLING_LAB_DB) for (const name of created) {
        assert.ok(names.includes(name) && name.startsWith(prefix + '_'));
        await connection.db.dropCollection(name);
    }
    await connection.close();
}
