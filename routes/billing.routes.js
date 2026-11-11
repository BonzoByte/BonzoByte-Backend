import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import Payment from '../models/sandboxPayment.model.js';
import { env } from '../config/env.js';
import { createSandboxCheckout } from '../utils/paypalSandbox.js';
import { createSandboxMembershipPreview } from '../utils/sandboxMembershipPreview.js';
import { billingLab } from '../utils/billingLabRuntime.js';
import { createBillingModule } from '../utils/billingModule.js';
import { planBilling } from '../utils/planBillingRuntime.js';

const config = { enabled: env.PAYPAL_SANDBOX_ENABLED === 'true', nodeEnv: env.NODE_ENV,
    clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET };
const checkout = createSandboxCheckout({ Payment, config });
const membershipPreview = createSandboxMembershipPreview({ Payment, config });
const billing = createBillingModule({ config, checkout, membershipPreview, lab: billingLab, plans: planBilling,
    webhookConfigured: !!env.PAYPAL_SANDBOX_WEBHOOK_ID });
const router = express.Router();
router.get('/config', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(billing.config());
});
router.use(protect, rateLimit({ windowMs: 60_000, max: 12, standardHeaders: true, legacyHeaders: false }));
const handle = fn => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json(await fn(req)); }
    catch (error) { res.status(error.status || 500).json({ code: error.status ? error.code : 'PAYPAL_UNAVAILABLE' }); }
};
router.post('/orders', handle(req => billing.create(req.user, req.body.plan, req.body.requestId)));
router.post('/orders/:orderId/capture', handle(req => billing.capture(req.user, req.params.orderId)));
router.get('/payments', handle(req => billing.status(req.user)));
router.post('/orders/:orderId/reconcile', handle(req => billing.reconcile(req.user, req.params.orderId)));
router.post('/orders/:orderId/refund', handle(req => billing.refund(req.user, req.params.orderId)));
// Compatibility URLs for older lab clients; identical policy, no second implementation.
if (billingLab) {
    router.get('/lab/payments', handle(req => billing.status(req.user)));
    router.post('/lab/orders/:orderId/reconcile', handle(req => billing.reconcile(req.user, req.params.orderId)));
    router.post('/lab/orders/:orderId/refund', handle(req => billing.refund(req.user, req.params.orderId)));
}
router.get('/membership-preview', handle(req => billing.preview(req.user)));
router.post('/orders/:orderId/membership-preview', handle(req => billing.preview(req.user, req.params.orderId)));
export default router;
