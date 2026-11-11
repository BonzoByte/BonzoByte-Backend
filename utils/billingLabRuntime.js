import mongoose from 'mongoose';
import { env } from '../config/env.js';
import User from '../models/user.model.js';
import { assertBillingLabEnvironment, assertBillingLabDatabase } from './billingLabSafety.js';
import { createPaypalSandboxApi } from './paypalSandboxApi.js';
import { createBillingLab } from './billingLab.js';
import { createBillingLabReconciliationRunner } from './billingLabReconciliation.js';

export const billingLabEnabled = assertBillingLabEnvironment();
let Payment, Event;
if (billingLabEnabled) {
    Payment = (await import('../models/billingLabPayment.model.js')).default;
    Event = (await import('../models/billingLabEvent.model.js')).default;
}
export const billingLab = billingLabEnabled ? createBillingLab({ connection: mongoose.connection, Payment, Event, User,
    api: createPaypalSandboxApi({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET,
        webhookId: env.PAYPAL_SANDBOX_WEBHOOK_ID }),
}) : null;

export async function initializeBillingLab() {
    if (!billingLab) return;
    assertBillingLabDatabase(mongoose.connection);
    await Promise.all([Payment.init(), Event.init(), User.init()]);
    const run = createBillingLabReconciliationRunner({ reconcile: () => billingLab.reconcileDue() });
    const timer = setInterval(run, 60_000); timer.unref();
    void run();
    console.log('[BILLING LAB] isolated database; sandbox only; 5-minute access; live payments disabled.');
}

export async function billingLabWebhook(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!billingLab) return res.sendStatus(404);
    try { res.json(await billingLab.webhook(req.body, req.headers)); }
    catch (error) { res.status(error.status || 503).json({ code: error.status ? error.code : 'WEBHOOK_RETRY_REQUIRED' }); }
}
