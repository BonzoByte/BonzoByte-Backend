import { BILLING_PLANS } from '../config/billingPlans.js';
import { createPaypalSandboxApi, paypalId } from './paypalSandboxApi.js';
import { evaluateMembership } from './membership.js';

const fail = (code, status = 502) => Object.assign(new Error(code), { code, status });
export const sandboxReady = config => config.enabled && config.nodeEnv !== 'production'
    && !!config.clientId && !!config.secret;
export function verifiedSandboxCapture(order, payment) {
    const units = order?.purchase_units;
    const capture = units?.[0]?.payments?.captures?.[0];
    if (order?.id !== payment.orderId || order?.status !== 'COMPLETED' || units?.length !== 1
        || units[0].custom_id !== String(payment._id) || units[0].payments?.captures?.length !== 1
        || capture?.status !== 'COMPLETED' || !paypalId(capture?.id)
        || (payment.captureId && capture.id !== payment.captureId)
        || capture.amount?.currency_code !== payment.currency || capture.amount?.value !== payment.amount)
        throw fail('PAYPAL_NOT_COMPLETED');
    return capture.id;
}
export function createSandboxCheckout({ Payment, config, fetchImpl = fetch }) {
    const { request: api } = createPaypalSandboxApi({ ...config, fetchImpl });
    const requireReady = user => {
        if (!sandboxReady(config)) throw fail('PAYPAL_NOT_CONFIGURED', 503);
        if (!user?._id || !user.isVerified) throw fail('VERIFICATION_REQUIRED', 403);
    };
    const owned = async (user, orderId) => {
        requireReady(user);
        if (!paypalId(orderId)) throw fail('INVALID_ORDER', 400);
        const payment = await Payment.findOne({ user: user._id, orderId });
        if (!payment) throw fail('ORDER_NOT_FOUND', 404);
        return payment;
    };
    const status = async user => {
        requireReady(user);
        const rows = await Payment.find({ user: user._id, orderId: { $ne: null } })
            .sort({ createdAt: -1, _id: -1 }).limit(10).lean();
        // Never expose payer details, repository IDs, idempotency keys or provider responses.
        return { sandbox: true, fulfillment: 'preview-only', entitlements: evaluateMembership(user),
            payments: rows.map(p => ({ orderId: p.orderId, plan: p.plan, amount: p.amount, currency: p.currency,
                status: p.status, grantEndsAt: null, revokedAt: null, refundStatus: null })) };
    };
    return {
        status,
        async reconcile(user, orderId) {
            const payment = await owned(user, orderId);
            // Read-only at PayPal: checking an approved order must NEVER capture it.
            const order = await api(`/v2/checkout/orders/${orderId}`);
            const units = order?.purchase_units, unit = units?.[0];
            if (order?.id !== orderId || units?.length !== 1 || unit.custom_id !== String(payment._id)
                || unit.amount?.value !== payment.amount || unit.amount?.currency_code !== payment.currency
                || !unit.payee?.merchant_id || (payment.merchantId && unit.payee.merchant_id !== payment.merchantId))
                throw fail('PAYMENT_MISMATCH');
            const captures = unit.payments?.captures ?? [];
            if (!Array.isArray(captures) || captures.length > 1) throw fail('PAYMENT_MISMATCH');
            const update = { lastCheckedAt: new Date() };
            if (captures.length) {
                const id = captures[0]?.id;
                if (!paypalId(id) || (payment.captureId && payment.captureId !== id)) throw fail('PAYMENT_MISMATCH');
                const capture = await api(`/v2/payments/captures/${id}`);
                if (capture?.id !== id || capture.amount?.value !== payment.amount
                    || capture.amount?.currency_code !== payment.currency
                    || capture.payee?.merchant_id !== unit.payee.merchant_id
                    || capture.supplementary_data?.related_ids?.order_id !== orderId) throw fail('PAYMENT_MISMATCH');
                const states = { COMPLETED: 'completed', PENDING: 'pending', REFUNDED: 'refunded',
                    PARTIALLY_REFUNDED: 'partially_refunded', DECLINED: 'failed', FAILED: 'failed', DENIED: 'failed' };
                if (!Object.hasOwn(states, capture.status)) throw fail('PAYMENT_MISMATCH');
                if (capture.status === 'COMPLETED' && order.status !== 'COMPLETED') throw fail('PAYMENT_MISMATCH');
                Object.assign(update, { status: states[capture.status], captureId: id, merchantId: unit.payee.merchant_id });
            } else {
                const states = { CREATED: 'created', SAVED: 'created', PAYER_ACTION_REQUIRED: 'created', APPROVED: 'approved', VOIDED: 'cancelled' };
                if (payment.captureId || !Object.hasOwn(states, order.status)) throw fail('PAYMENT_MISMATCH');
                update.status = states[order.status];
            }
            // Compare-and-set: a delayed concurrent check cannot overwrite newer evidence.
            // Refunded is terminal, and partial refunds cannot return to completed.
            if (payment.status === 'refunded' || (payment.status === 'partially_refunded' && update.status !== 'refunded'))
                update.status = payment.status;
            await Payment.updateOne({ _id: payment._id, user: user._id, status: payment.status,
                updatedAt: payment.updatedAt }, { $set: update });
            return status(user);
        },
        async create(user, plan, requestId) {
            requireReady(user);
            if (!Object.hasOwn(BILLING_PLANS, plan) || typeof requestId !== 'string'
                || !/^[a-f0-9-]{36}$/i.test(requestId)) throw fail('INVALID_ORDER', 400);
            let payment;
            try {
                payment = await Payment.findOneAndUpdate({ user: user._id, requestId }, { $setOnInsert: {
                    user: user._id, requestId, plan, amount: '0.01', currency: 'EUR',
                } }, { upsert: true, new: true });
            } catch (error) {
                if (error.code !== 11000) throw error;
                payment = await Payment.findOne({ user: user._id, requestId });
            }
            if (!payment || payment.plan !== plan) throw fail('INVALID_ORDER', 400);
            if (payment.orderId) return { orderId: payment.orderId };
            const order = await api('/v2/checkout/orders', 'POST', {
                intent: 'CAPTURE', purchase_units: [{ custom_id: String(payment._id),
                    description: `BonzoByte SANDBOX test — ${plan} (no membership activation)`,
                    amount: { currency_code: payment.currency, value: payment.amount } }],
                application_context: { shipping_preference: 'NO_SHIPPING' },
            }, String(payment._id) + '-create');
            if (!/^[A-Z0-9]{10,32}$/.test(order.id ?? '')) throw fail('PAYPAL_UNAVAILABLE');
            await Payment.updateOne({ _id: payment._id }, { $set: { orderId: order.id,
                merchantId: order.purchase_units?.[0]?.payee?.merchant_id ?? null } });
            return { orderId: order.id };
        },
        async capture(user, orderId) {
            const payment = await owned(user, orderId);
            if (['refunded', 'partially_refunded', 'failed', 'cancelled'].includes(payment.status))
                throw fail('PAYPAL_NOT_COMPLETED', 409);
            if (payment.status !== 'completed') {
                let order;
                try { order = await api(`/v2/checkout/orders/${orderId}/capture`, 'POST', {}, String(payment._id) + '-capture'); }
                catch (error) {
                    if (error.code !== 'ORDER_ALREADY_CAPTURED') throw error;
                    order = await api(`/v2/checkout/orders/${orderId}`);
                }
                const captureId = verifiedSandboxCapture(order, payment);
                const written = await Payment.updateOne({ _id: payment._id, user: user._id,
                    status: { $nin: ['refunded', 'partially_refunded', 'failed', 'cancelled'] } },
                { $set: { status: 'completed', captureId } });
                if (written?.matchedCount === 0) throw fail('PAYPAL_NOT_COMPLETED', 409);
            }
            // Sandbox money must NEVER grant real Premium/VIP or change the live user record.
            return { completed: true, sandbox: true, membershipActivated: false };
        },
    };
}
