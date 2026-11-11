import { sandboxReady } from './paypalSandbox.js';
import { billingError } from './paypalSandboxApi.js';
import { BILLING_PLANS } from '../config/billingPlans.js';

// One application-facing contract. The lab adapter is supplied only after the
// runtime's dedicated database/JWT/environment guards have passed. No Live mode.
export function createBillingModule({ config, checkout, membershipPreview, lab = null, plans = null, webhookConfigured = false }) {
    const fulfillment = lab ? 'isolated-lab' : plans ? 'sandbox-plans' : 'preview-only';
    const capabilities = Object.freeze({ history: true, reconcile: true, refund: !!lab || !!plans,
        membershipPreview: !lab && !plans, activatesMembership: !!lab || !!plans, livePayments: false });
    const adapter = lab || plans || checkout;
    const requireReady = user => {
        if (!sandboxReady(config)) throw billingError('PAYPAL_NOT_CONFIGURED', 503);
        if (!user?._id || !user.isVerified) throw billingError('VERIFICATION_REQUIRED', 403);
    };
    const wrapStatus = result => {
        if (result?.sandbox !== true || result.fulfillment !== fulfillment || !Array.isArray(result.payments))
            throw billingError('BILLING_ENVIRONMENT_MISMATCH', 409);
        return { ...result, capabilities };
    };
    return {
        config() {
            const enabled = sandboxReady(config);
            return { enabled, sandbox: true, protocolVersion: plans && !lab ? 2 : 1, fulfillment, capabilities,
                clientId: enabled ? config.clientId : null, currency: 'EUR', amount: plans ? null : '0.01',
                durationSeconds: lab ? 300 : null, webhookConfigured: (!!lab || !!plans) && !!webhookConfigured,
                ...(plans ? { plans: Object.entries(BILLING_PLANS).filter(([key]) => key !== 'founders')
                    .map(([key, p]) => ({ key, amount: p.priceEur.toFixed(2), currency: 'EUR', durationDays: p.durationDays })) } : {}) };
        },
        async create(user, plan, requestId) { requireReady(user); return adapter.create(user, plan, requestId); },
        async capture(user, id) { requireReady(user); return adapter.capture(user, id); },
        async status(user) { requireReady(user); return wrapStatus(await adapter.status(user)); },
        async reconcile(user, id) { requireReady(user); return wrapStatus(await adapter.reconcile(user, id)); },
        async refund(user, id) {
            requireReady(user);
            if (!lab && !plans) throw billingError('BILLING_ACTION_NOT_ALLOWED', 403);
            return wrapStatus(await adapter.refund(user, id));
        },
        async preview(user, id) {
            requireReady(user);
            if (lab || plans) throw billingError('BILLING_ACTION_NOT_ALLOWED', 403);
            return id === undefined ? membershipPreview.status(user) : membershipPreview.start(user, id);
        },
    };
}
