import { sandboxReady } from './paypalSandbox.js';
import { billingError } from './paypalSandboxApi.js';
import { BILLING_PLANS } from '../config/billingPlans.js';

// One application-facing contract. The lab adapter is supplied only after the
// runtime's dedicated database/JWT/environment guards have passed.
export function createBillingModule({ config, checkout, membershipPreview, lab = null, plans = null, live = null, webhookConfigured = false }) {
    if (live && (lab || plans || config.environment !== 'live')) throw billingError('BILLING_ENVIRONMENT_MISMATCH', 503);
    const isLive = config.environment === 'live';
    const fulfillment = isLive ? 'live-plans' : lab ? 'isolated-lab' : plans ? 'sandbox-plans' : 'preview-only';
    const capabilities = Object.freeze({ history: true, reconcile: true, refund: !isLive && (!!lab || !!plans),
        membershipPreview: !isLive && !lab && !plans, activatesMembership: isLive || !!lab || !!plans, livePayments: isLive });
    const adapter = isLive ? live : lab || plans || checkout;
    const ready = () => isLive ? !!(config.enabled && config.clientId && config.secret && webhookConfigured && live) : sandboxReady(config);
    const requireReady = user => {
        if (!ready()) throw billingError('PAYPAL_NOT_CONFIGURED', 503);
        if (!user?._id || !user.isVerified) throw billingError('VERIFICATION_REQUIRED', 403);
    };
    const requireContext = context => {
        if (isLive && (context?.environment !== 'live' || context?.protocolVersion !== 3))
            throw billingError('BILLING_CLIENT_UPDATE_REQUIRED', 409);
    };
    const wrapStatus = result => {
        if (result?.sandbox !== !isLive || result.fulfillment !== fulfillment || !Array.isArray(result.payments))
            throw billingError('BILLING_ENVIRONMENT_MISMATCH', 409);
        return { ...result, capabilities };
    };
    return {
        config() {
            const enabled = ready();
            return { enabled, sandbox: !isLive, protocolVersion: isLive ? 3 : plans && !lab ? 2 : 1, fulfillment, capabilities,
                clientId: enabled ? config.clientId : null, currency: 'EUR', amount: plans || isLive ? null : '0.01',
                durationSeconds: lab ? 300 : null, webhookConfigured: (isLive || !!lab || !!plans) && !!webhookConfigured,
                ...(plans || isLive ? { plans: Object.entries(BILLING_PLANS).filter(([key]) => key !== 'founders')
                    .map(([key, p]) => ({ key, amount: p.priceEur.toFixed(2), currency: 'EUR', durationDays: p.durationDays })) } : {}) };
        },
        async create(user, plan, requestId, context) { requireReady(user); requireContext(context); return adapter.create(user, plan, requestId); },
        async capture(user, id, context) { requireReady(user); requireContext(context); return adapter.capture(user, id); },
        async status(user) { requireReady(user); return wrapStatus(await adapter.status(user)); },
        async reconcile(user, id) { requireReady(user); return wrapStatus(await adapter.reconcile(user, id)); },
        async refund(user, id) {
            requireReady(user);
            if (isLive || (!lab && !plans)) throw billingError('BILLING_ACTION_NOT_ALLOWED', 403);
            return wrapStatus(await adapter.refund(user, id));
        },
        async preview(user, id) {
            requireReady(user);
            if (isLive || lab || plans) throw billingError('BILLING_ACTION_NOT_ALLOWED', 403);
            return id === undefined ? membershipPreview.status(user) : membershipPreview.start(user, id);
        },
    };
}
