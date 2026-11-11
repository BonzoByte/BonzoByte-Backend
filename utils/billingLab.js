import crypto from 'node:crypto';
import { BILLING_PLANS } from '../config/billingPlans.js';
import { evaluateMembership } from './membership.js';
import { assertBillingLabDatabase, BILLING_LAB_DURATION_MS } from './billingLabSafety.js';
import { billingError, paypalId } from './paypalSandboxApi.js';
import { DAY_MS, paidMembershipWindows } from './paidMembership.js';

const equalId = (a, b) => String(a) === String(b);
export function verifiedLabOrder(order, payment) {
    const units = order?.purchase_units;
    if (order?.id !== payment.orderId || units?.length !== 1 || units[0].custom_id !== String(payment._id)
        || units[0].amount?.value !== payment.amount || units[0].amount?.currency_code !== payment.currency
        || !payment.merchantId || units[0].payee?.merchant_id !== payment.merchantId)
        throw billingError('PAYMENT_MISMATCH', 409);
    const captures = units[0].payments?.captures ?? [];
    if (captures.length > 1) throw billingError('PAYMENT_MISMATCH', 409);
    return captures[0];
}
export function verifiedLabCapture(capture, payment, expectedId) {
    if (!paypalId(capture?.id) || capture.id !== expectedId
        || (payment.captureId && capture.id !== payment.captureId)
        || capture.amount?.value !== payment.amount || capture.amount?.currency_code !== payment.currency
        || capture.payee?.merchant_id !== payment.merchantId
        || capture.supplementary_data?.related_ids?.order_id !== payment.orderId)
        throw billingError('PAYMENT_MISMATCH', 409);
    if (!['COMPLETED', 'PENDING', 'DECLINED', 'FAILED', 'DENIED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(capture.status))
        throw billingError('PAYMENT_STATUS_UNKNOWN', 409);
    return capture;
}
const publicPayment = payment => ({ orderId: payment.orderId, plan: payment.plan, status: payment.status,
    amount: payment.amount, currency: payment.currency, grantEndsAt: payment.grantEndsAt ?? null,
    revokedAt: payment.revokedAt ?? null, refundStatus: payment.refundStatus ?? null });
function verifiedRefund(refund, payment) {
    if (!paypalId(refund?.id) || (payment.refundId && refund.id !== payment.refundId)
        || refund.amount?.value !== payment.amount || refund.amount?.currency_code !== payment.currency
        || !['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED'].includes(refund.status)) throw billingError('PAYMENT_MISMATCH', 409);
    return refund;
}

// Lab and full-duration sandbox plans share the verified payment engine but use
// distinct guards, collections and entitlement models. No Live endpoint exists.
// All grant/revoke changes commit with their receipts in a Mongo transaction.
export function createBillingLab({ connection, Payment, Event, User, api, now = () => new Date(), planMode = false, assertPlanEnvironment, notifications }) {
    const guard = () => {
        if (!planMode) return assertBillingLabDatabase(connection);
        if (typeof assertPlanEnvironment !== 'function') throw billingError('PLAN_ENVIRONMENT_REQUIRED', 503);
        assertPlanEnvironment();
    };
    const fulfillment = planMode ? 'sandbox-plans' : 'isolated-lab';
    const membership = member => evaluateMembership(member, now(), { allowSandboxMembership: planMode });
    const validPlanPayment = row => {
        if (planMode && (row?.environment !== 'sandbox' || row.version !== 1 || !Number.isInteger(row.durationDays)
            || row.durationDays < 1 || row.durationDays > 365 || row.plan === 'founders')) throw billingError('PAYMENT_MISMATCH', 409);
    };
    async function initializeLedger(user) {
        if (!planMode) return;
        await connection.transaction(async session => {
            const member = await User.findById(user._id).session(session);
            if (!member) throw billingError('USER_NOT_FOUND', 404);
            const rights = membership(member);
            if (member.vip?.enabled || member.isAdmin || (rights.isPremium && !rights.sandboxMembership))
                throw billingError('UNMANAGED_MEMBERSHIP', 409);
            if (!member.billingMembership) {
                const at = now();
                member.billingMembership = { version: 1, environment: 'sandbox', baselineAt: at,
                    baselineTrialMs: rights.hasTrial ? Math.max(0, new Date(member.trial?.endsAt ?? 0).getTime() - at.getTime()) || 0 : 0,
                    trialCredits: [], grants: [] };
                await member.save({ session });
            }
        });
    }
    const requireUser = user => {
        guard();
        if (!user?._id || !user.isVerified) throw billingError('VERIFICATION_REQUIRED', 403);
    };
    async function owned(user, orderId) {
        requireUser(user);
        if (!paypalId(orderId)) throw billingError('INVALID_ORDER', 400);
        const row = await Payment.findOne({ user: user._id, orderId });
        if (!row) throw billingError('ORDER_NOT_FOUND', 404);
        validPlanPayment(row);
        return row;
    }
    async function reconcileRow(payment, receipt, forceRevoke) {
        guard();
        validPlanPayment(payment);
        const order = await api.request(`/v2/checkout/orders/${payment.orderId}`);
        const orderCapture = verifiedLabOrder(order, payment);
        if (order.status === 'COMPLETED' && !orderCapture) throw billingError('PAYMENT_MISMATCH', 409);
        let capture;
        if (orderCapture) {
            if (!paypalId(orderCapture.id)) throw billingError('PAYMENT_MISMATCH', 409);
            capture = verifiedLabCapture(await api.request(`/v2/payments/captures/${orderCapture.id}`), payment, orderCapture.id);
        }
        if (forceRevoke && (!capture || forceRevoke.captureId !== capture.id)) throw billingError('PAYMENT_MISMATCH', 409);
        if (capture?.status === 'COMPLETED' && order.status !== 'COMPLETED') throw billingError('PAYMENT_MISMATCH', 409);
        // A pending refund must be rechecked too; capture can remain COMPLETED
        // while a failed/pending refund changes state. Never leave the UI stuck.
        const refund = payment.refundId ? verifiedRefund(await api.request(`/v2/payments/refunds/${payment.refundId}`), payment) : null;
        const at = now();
        await connection.transaction(async session => {
            if (receipt) {
                const oldEvent = await Event.findOne({ eventId: receipt.eventId }).session(session);
                if (oldEvent) {
                    if (oldEvent.digest !== receipt.digest) throw billingError('WEBHOOK_ID_CONFLICT', 409);
                    return;
                }
            }
            const row = await Payment.findById(payment._id).session(session);
            if (!row || !equalId(row.user, payment.user)) throw billingError('ORDER_NOT_FOUND', 404);
            if (row.captureId && capture && row.captureId !== capture.id) throw billingError('PAYMENT_MISMATCH', 409);
            const revoke = !!forceRevoke || refund?.status === 'COMPLETED' || ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(capture?.status);
            if (refund && row.refundId === refund.id) row.refundStatus = capture?.status === 'REFUNDED' ? 'COMPLETED' : refund.status;
            if (capture) row.captureId = capture.id;
            if (revoke && !row.revokedAt) {
                const reversedAt = planMode ? new Date(forceRevoke?.at ?? refund?.update_time ?? capture?.update_time ?? at) : at;
                row.revokedAt = Number.isFinite(reversedAt.getTime()) && reversedAt <= at ? reversedAt : at;
                row.revocationReason = forceRevoke?.reason ?? 'refund';
            }
            if (planMode && capture && (capture.status === 'COMPLETED' || revoke) && !row.grantStartedAt) {
                const paidAt = new Date(capture.create_time);
                if (!Number.isFinite(paidAt.getTime()) || paidAt > new Date(at.getTime() + 5000)
                    || paidAt < new Date(row.createdAt.getTime() - 5000)) throw billingError('PAYMENT_TIME_MISMATCH', 409);
                row.grantStartedAt = paidAt > at ? at : paidAt;
                row.grantEndsAt = new Date(row.grantStartedAt.getTime() + row.durationDays * DAY_MS);
            }
            if (row.revokedAt) row.status = row.revocationReason === 'reversal' ? 'reversed' : 'refunded';
            else if (capture?.status === 'COMPLETED') {
                row.status = 'completed';
                // Replayed confirmation never moves the original window, including after expiry.
                if (!row.grantStartedAt) {
                    row.grantStartedAt = at; row.grantEndsAt = new Date(at.getTime() + BILLING_LAB_DURATION_MS);
                }
            } else if (!row.grantStartedAt) row.status = capture?.status?.toLowerCase() ?? order.status?.toLowerCase() ?? 'created';
            row.lastCheckedAt = at;
            const expiredReceipt = planMode && row.grantEndsAt && row.grantEndsAt <= at && row.refundStatus !== 'PENDING';
            row.nextCheckAt = new Date(at.getTime() + (expiredReceipt ? DAY_MS : 60_000)); row.checkFailures = 0;
            await row.save({ session });
            const member = await User.findById(row.user).session(session);
            if (!member) throw billingError('USER_NOT_FOUND', 409);
            // Finish observing any already-started payment, but never restore
            // membership or enqueue new notifications for a closing account.
            if (member.accountClosure?.requestedAt) {
                if (receipt) await Event.create([{ ...receipt, orderId: row.orderId }], { session });
                return;
            }
            if (planMode) {
                if (!member.billingMembership || member.billingMembership.version !== 1 || member.billingMembership.environment !== 'sandbox')
                    throw billingError('MEMBERSHIP_LEDGER_REQUIRED', 409);
                // Rebuild from this version's receipts in the SAME transaction. User is the
                // shared serialization point for concurrent purchases/refunds/referral credits.
                const receipts = await Payment.find({ user: row.user, environment: 'sandbox', version: 1,
                    grantStartedAt: { $exists: true } }).session(session);
                member.billingMembership.grants = receipts.map(p => ({ paymentId: String(p._id), paidAt: p.grantStartedAt,
                    durationMs: p.testDurationMs ?? p.durationDays * DAY_MS, revokedAt: p.revokedAt ?? null }));
                const windows = paidMembershipWindows(member.billingMembership.grants);
                for (const p of receipts) {
                    const end = windows.find(w => w.paymentId === String(p._id))?.end;
                    if (end && p.grantEndsAt?.getTime() !== end)
                        await Payment.updateOne({ _id: p._id }, { $set: { grantEndsAt: new Date(end) } }, { session });
                }
                await member.save({ session });
                // Commit the notification intent with the grant/revocation. Never
                // contact an email provider from this retriable DB transaction.
                await notifications?.enqueue({ payment: row, member, rights: membership(member), at, session,
                    fullRefundConfirmed: refund?.status === 'COMPLETED' || capture?.status === 'REFUNDED' });
                if (receipt) await Event.create([{ ...receipt, orderId: row.orderId }], { session });
                return;
            }
            // No migrated/live/administrative membership may be overwritten by this test engine.
            if (member.subscription?.status === 'active' && member.subscription?.subscriptionId !== 'billing-lab')
                throw billingError('UNMANAGED_MEMBERSHIP', 409);
            const surviving = await Payment.findOne({ user: row.user, status: 'completed', revokedAt: null,
                grantEndsAt: { $gt: at } }).sort({ grantEndsAt: -1 }).session(session);
            // Rechecking an expired purchase must not rewrite its membership end
            // to "now" every minute. A refund may shorten, never extend, that end.
            const previousEnd = member.subscription?.validUntil?.getTime();
            const endedAt = Number.isFinite(previousEnd) ? new Date(Math.min(previousEnd, at.getTime())) : at;
            member.subscription = { provider: 'paypal', status: surviving ? 'active' : 'expired',
                validUntil: surviving?.grantEndsAt ?? endedAt, subscriptionId: 'billing-lab', isLifetime: false };
            // Trial, VIP, ads preferences and role flags remain untouched.
            await member.save({ session });
            if (receipt) await Event.create([{ ...receipt, orderId: row.orderId }], { session });
        });
        return Payment.findById(payment._id);
    }
    async function status(user) {
        requireUser(user);
        const member = await User.findById(user._id);
        if (!member) throw billingError('USER_NOT_FOUND', 404);
        const payments = await Payment.find({ user: user._id, orderId: { $exists: true } }).sort({ createdAt: -1 }).limit(10);
        return { sandbox: true, fulfillment, durationSeconds: planMode ? null : BILLING_LAB_DURATION_MS / 1000,
            entitlements: membership(member), payments: payments.map(p => ({ ...publicPayment(p), ...(planMode ? {
                capturePending: !p.grantStartedAt && !p.revokedAt && (p.status === 'pending'
                    || (!!p.captureRequestedAt && p.captureRequestUntil > now()
                        && !['failed', 'declined', 'denied', 'cancelled', 'voided'].includes(p.status))),
            } : {}) })) };
    }
    return {
        status,
        async create(user, plan, requestId) {
            requireUser(user);
            if (!Object.hasOwn(BILLING_PLANS, plan) || plan === 'founders' || typeof requestId !== 'string'
                || !/^[a-f0-9-]{36}$/i.test(requestId)) throw billingError('INVALID_ORDER', 400);
            if (planMode) {
                const uncertain = await Payment.findOne({ user: user._id, captureRequestedAt: { $exists: true },
                    grantStartedAt: null, revokedAt: null, status: { $nin: ['failed', 'declined', 'denied', 'cancelled', 'voided'] } });
                if (uncertain) {
                    const checked = await reconcileRow(uncertain);
                    if (!checked.grantStartedAt && (checked.status === 'pending' || checked.captureRequestUntil > now()))
                        throw billingError('PAYMENT_PENDING', 409);
                }
            }
            await initializeLedger(user);
            let payment;
            try { payment = await Payment.findOneAndUpdate({ user: user._id, requestId }, { $setOnInsert: {
                user: user._id, requestId, plan, amount: planMode ? BILLING_PLANS[plan].priceEur.toFixed(2) : '0.01', currency: 'EUR', nextCheckAt: now(),
                ...(planMode ? { environment: 'sandbox', version: 1, durationDays: BILLING_PLANS[plan].durationDays,
                    ...notifications?.newOrderFields } : {}),
            } }, { upsert: true, new: true }); }
            catch (error) {
                if (error.code !== 11000) throw error;
                payment = await Payment.findOne({ user: user._id, requestId });
            }
            if (!payment || payment.plan !== plan) throw billingError('INVALID_ORDER', 400);
            validPlanPayment(payment);
            if (payment.orderId) return { orderId: payment.orderId };
            const order = await api.request('/v2/checkout/orders', 'POST', { intent: 'CAPTURE', purchase_units: [{
                custom_id: String(payment._id), description: planMode ? `BonzoByte ${plan} - ${payment.durationDays} days (Sandbox)` : 'BonzoByte isolated billing lab: 5-minute test access',
                amount: { value: payment.amount, currency_code: 'EUR' },
            }], application_context: { shipping_preference: 'NO_SHIPPING' } }, String(payment._id) + '-create');
            if (!paypalId(order?.id)) throw billingError('PAYPAL_UNAVAILABLE');
            const merchant = order.purchase_units?.[0]?.payee?.merchant_id;
            if (typeof merchant !== 'string' || !/^[A-Z0-9]{5,32}$/.test(merchant)) throw billingError('PAYMENT_MISMATCH', 409);
            verifiedLabOrder(order, { ...payment.toObject(), orderId: order.id, merchantId: merchant });
            await Payment.updateOne({ _id: payment._id }, { $set: { orderId: order.id, merchantId: merchant } });
            return { orderId: order.id };
        },
        async capture(user, orderId) {
            const payment = await owned(user, orderId);
            if (planMode && payment.revokedAt) throw billingError('PAYMENT_REVOKED', 409);
            if (!payment.grantStartedAt && !payment.revokedAt) {
                if (planMode) {
                    // Persistent intent allows an uncertain capture to be reconciled after
                    // disconnect/restart. The worker never POSTs a capture on its own.
                    const at = now();
                    const claim = await Payment.updateOne({ _id: payment._id, $or: [
                        { captureRequestUntil: null }, { captureRequestUntil: { $lte: at } },
                    ] }, { $set: { captureRequestedAt: at, captureRequestUntil: new Date(at.getTime() + 120000), nextCheckAt: at } });
                    if (!claim.matchedCount) {
                        await reconcileRow(payment);
                        const result = await status(user);
                        return { ...result, completed: result.payments.some(p => p.orderId === orderId && p.status === 'completed'),
                            membershipActivated: result.entitlements.isPremium };
                    }
                }
                try { await api.request(`/v2/checkout/orders/${orderId}/capture`, 'POST', {}, String(payment._id) + '-capture'); }
                catch (error) {
                    if (planMode && error.code === 'INSTRUMENT_DECLINED')
                        await Payment.updateOne({ _id: payment._id }, { $unset: { captureRequestUntil: 1 } });
                    if (error.code !== 'ORDER_ALREADY_CAPTURED') throw error;
                }
            }
            const row = await reconcileRow(payment);
            const current = await status(user);
            return { ...current, completed: row.status === 'completed', membershipActivated: row.status === 'completed'
                && (planMode ? current.entitlements.isPremium : row.grantEndsAt?.getTime() > now().getTime()) };
        },
        async reconcile(user, orderId) { await reconcileRow(await owned(user, orderId)); return status(user); },
        async refund(user, orderId) {
            let row = await reconcileRow(await owned(user, orderId));
            if (row.revokedAt) return status(user);
            if (row.status !== 'completed' || !paypalId(row.captureId)) throw billingError('REFUND_NOT_AVAILABLE', 409);
            let refund;
            if (row.refundId) refund = await api.request(`/v2/payments/refunds/${row.refundId}`);
            else {
                try { refund = await api.request(`/v2/payments/captures/${row.captureId}/refund`, 'POST', {
                    amount: { value: row.amount, currency_code: row.currency }, note_to_payer: 'BonzoByte sandbox test refund',
                }, String(row._id) + '-refund'); }
                catch (error) {
                    if (error.code !== 'CAPTURE_FULLY_REFUNDED') throw error;
                    await reconcileRow(row); return status(user);
                }
            }
            verifiedRefund(refund, row);
            await Payment.updateOne({ _id: row._id }, { $set: { refundId: refund.id, refundStatus: refund.status } });
            // Re-read the saved refund ID so reconciliation verifies the refund
            // even when the capture endpoint still reports COMPLETED for a while.
            await reconcileRow(await Payment.findById(row._id), undefined,
                refund.status === 'COMPLETED' ? { captureId: row.captureId, reason: 'refund' } : undefined);
            return status(user);
        },
        async webhook(raw, headers) {
            guard();
            const event = await api.verifyWebhook(raw, headers);
            const receipt = { eventId: event.id, eventType: event.event_type, digest: crypto.createHash('sha256').update(raw).digest('hex') };
            const seen = await Event.findOne({ eventId: receipt.eventId });
            if (seen) {
                if (seen.digest !== receipt.digest) throw billingError('WEBHOOK_ID_CONFLICT', 409);
                return { received: true, duplicate: true };
            }
            if (!['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED',
                'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'CHECKOUT.ORDER.APPROVED'].includes(event.event_type))
                return { received: true, ignored: true };
            let captureId = event.event_type.startsWith('PAYMENT.CAPTURE.') && event.event_type !== 'PAYMENT.CAPTURE.REFUNDED' ? event.resource?.id : undefined;
            let orderId = event.event_type === 'CHECKOUT.ORDER.APPROVED' ? event.resource?.id
                : event.resource?.supplementary_data?.related_ids?.order_id;
            if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
                captureId = event.resource?.supplementary_data?.related_ids?.capture_id;
                for (const link of event.resource?.links ?? []) {
                    if (link.rel !== 'up') continue;
                    try {
                        const url = new URL(link.href);
                        if (url.protocol === 'https:' && ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(url.hostname)
                            && !url.username && !url.password && !url.port && !url.search && !url.hash)
                            captureId ||= /^\/v2\/payments\/captures\/([A-Z0-9]{10,32})$/.exec(url.pathname)?.[1];
                    } catch { /* Invalid provider link cannot select a payment. */ }
                }
            }
            let payment = paypalId(orderId) ? await Payment.findOne({ orderId }) : null;
            if (!payment && paypalId(captureId)) {
                payment = await Payment.findOne({ captureId });
                // Capture may have completed before the browser saved its response.
                if (!payment) {
                    const capture = await api.request(`/v2/payments/captures/${captureId}`);
                    orderId = capture.supplementary_data?.related_ids?.order_id;
                    if (paypalId(orderId)) payment = await Payment.findOne({ orderId });
                }
            }
            if (!payment) return { received: true, ignored: true };
            // Approved order notifications only reconcile; they never capture money automatically.
            const forceRevoke = event.event_type === 'PAYMENT.CAPTURE.REVERSED' ? { captureId, reason: 'reversal', at: event.create_time } : undefined;
            try { await reconcileRow(payment, receipt, forceRevoke); }
            catch (error) {
                if (error.code !== 11000) throw error;
                const persisted = await Event.findOne({ eventId: receipt.eventId });
                if (!persisted || persisted.digest !== receipt.digest) throw error;
            }
            return { received: true };
        },
        async reconcileDue(limit = 10) {
            guard(); const at = now();
            const due = await Payment.find({ orderId: { $exists: true }, revokedAt: null, nextCheckAt: { $lte: at },
                ...(planMode ? { $or: [ { grantStartedAt: { $exists: true } }, { captureRequestedAt: { $exists: true } },
                    { createdAt: { $gte: new Date(at.getTime() - 3 * DAY_MS) } } ] }
                    : { createdAt: { $gte: new Date(at.getTime() - 3 * DAY_MS) } }) }).sort({ nextCheckAt: 1 }).limit(Math.min(10, limit));
            let succeeded = 0;
            for (const payment of due) {
                try { await reconcileRow(payment); succeeded++; }
                catch {
                    await Payment.updateOne({ _id: payment._id }, { $inc: { checkFailures: 1 }, $set: {
                        nextCheckAt: new Date(now().getTime() + Math.min(300000, 60000 * (1 + payment.checkFailures))),
                    } });
                }
            }
            return { checked: due.length, succeeded };
        },
    };
}
