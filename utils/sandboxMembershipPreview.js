import { evaluateMembership } from './membership.js';
import { sandboxReady } from './paypalSandbox.js';

export const PREVIEW_DURATION_MS = 5 * 60_000;
const fail = (code, status) => Object.assign(new Error(code), { code, status });

// Deliberately receives only the sandbox-payment repository, never a User writer.
// This service simulates the real evaluator but cannot grant actual access.
export function createSandboxMembershipPreview({ Payment, config, now = () => new Date() }) {
    const requireReady = user => {
        if (!sandboxReady(config)) throw fail('PAYPAL_NOT_CONFIGURED', 503);
        if (!user?.isVerified) throw fail('VERIFICATION_REQUIRED', 403);
    };
    const eligible = user => ({ user: user._id, status: 'completed', amount: '0.01', currency: 'EUR',
        captureId: { $regex: '^[A-Z0-9]{10,32}$' }, orderId: { $regex: '^[A-Z0-9]{10,32}$' } });
    const result = (user, payment, at) => {
        const actual = evaluateMembership(user, at);
        const window = payment?.membershipPreview;
        const start = window?.startedAt == null ? NaN : new Date(window.startedAt).getTime();
        const end = window?.endsAt == null ? NaN : new Date(window.endsAt).getTime();
        const started = window?.startedAt != null || window?.endsAt != null;
        if (started && (!Number.isFinite(start) || end - start !== PREVIEW_DURATION_MS))
            throw fail('SANDBOX_PREVIEW_INVALID', 409);
        const active = started && start <= at.getTime() && end > at.getTime();
        const state = !payment ? 'unavailable' : !started ? 'ready' : active ? 'active' : 'expired';
        const simulated = active && !actual.isPremium && !user.isAdmin
            ? evaluateMembership({ trial: user.trial, vip: user.vip, ads: user.ads,
                subscription: { provider: 'manual', status: 'active', validUntil: new Date(end), isLifetime: false } }, at)
            : actual;
        return { sandbox: true, realMembershipChanged: false, serverNow: at.toISOString(),
            durationSeconds: PREVIEW_DURATION_MS / 1000, state,
            orderId: payment?.orderId ?? null, plan: payment?.plan ?? null,
            startedAt: started ? new Date(start).toISOString() : null,
            endsAt: started ? new Date(end).toISOString() : null,
            actual, simulated };
    };
    return {
        async status(user) {
            requireReady(user);
            const payment = await Payment.findOne(eligible(user), null, { sort: { createdAt: -1, _id: -1 } });
            return result(user, payment, now());
        },
        async start(user, orderId) {
            requireReady(user);
            if (typeof orderId !== 'string' || !/^[A-Z0-9]{10,32}$/.test(orderId))
                throw fail('INVALID_ORDER', 400);
            const at = now();
            const filter = { ...eligible(user), orderId };
            // One atomic write, without upsert: pending/cancelled/foreign orders cannot qualify.
            // Null matches legacy documents without the new preview fields as well.
            let payment = await Payment.findOneAndUpdate({ ...filter,
                'membershipPreview.startedAt': null, 'membershipPreview.endsAt': null },
            { $set: { 'membershipPreview.startedAt': at,
                'membershipPreview.endsAt': new Date(at.getTime() + PREVIEW_DURATION_MS) } }, { new: true });
            if (!payment) payment = await Payment.findOne(filter);
            if (!payment) throw fail('COMPLETED_SANDBOX_ORDER_REQUIRED', 409);
            return result(user, payment, at);
        },
    };
}
