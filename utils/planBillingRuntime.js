import mongoose from 'mongoose';
import { env } from '../config/env.js';
import User from '../models/user.model.js';
import Payment from '../models/planPayment.model.js';
import Event from '../models/planPaymentEvent.model.js';
import Outbox from '../models/billingEmail.model.js';
import mailer from './mailer.js';
import { createBillingEmailQueue } from './billingEmail.js';
import { createBillingLab } from './billingLab.js';
import { createPaypalSandboxApi, billingError } from './paypalSandboxApi.js';
import { createBillingLabReconciliationRunner } from './billingLabReconciliation.js';
import { billingLab, billingLabEnabled, billingLabWebhook } from './billingLabRuntime.js';

export const planBillingEnabled = env.PAYPAL_MEMBERSHIP_ENABLED === 'true' && !billingLabEnabled;
function guard() {
    if (!planBillingEnabled || env.NODE_ENV === 'production' || env.PAYPAL_SANDBOX_ENABLED !== 'true'
        || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || billingLabEnabled)
        throw billingError('SANDBOX_PLAN_ENVIRONMENT_REQUIRED', 503);
}
if (planBillingEnabled) guard();
const notifications = planBillingEnabled ? createBillingEmailQueue({ Outbox, mailer,
    enabled: env.BILLING_EMAIL_ENABLED === 'true', canSendPayment: async id => {
        const payment = await Payment.findById(id).select('user').lean();
        return !!payment && !!await User.exists({ _id: payment.user, 'accountClosure.requestedAt': { $exists: false } });
    } }) : null;
export const planBilling = planBillingEnabled ? createBillingLab({ connection: mongoose.connection, Payment, Event, User,
    planMode: true, assertPlanEnvironment: guard, notifications,
    api: createPaypalSandboxApi({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, webhookId: env.PAYPAL_SANDBOX_WEBHOOK_ID }),
}) : null;
export async function initializePlanBilling() {
    if (!planBilling) return;
    guard();
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Plan membership requires MongoDB transactions (replica set).');
    await Promise.all([Payment.init(), Event.init(), Outbox.init()]);
    const run = createBillingLabReconciliationRunner({ label: 'BILLING', reconcile: () => planBilling.reconcileDue() });
    const timer = setInterval(run, 60000); timer.unref(); void run();
    if (env.BILLING_EMAIL_ENABLED === 'true') {
        const send = createBillingLabReconciliationRunner({ label: 'BILLING MAIL', reconcile: () => notifications.processDue() });
        const mailTimer = setInterval(send, 15000); mailTimer.unref(); void send();
        console.log(`[BILLING MAIL] new-order notifications enabled; ready=${mailer.isConfigured && mailer.provider === 'resend'}`);
    }
    console.log('[BILLING] sandbox plans; actual plan durations; paused trial; live payments disabled.');
}
export async function billingWebhook(req, res) {
    if (billingLab) return billingLabWebhook(req, res);
    res.set('Cache-Control', 'no-store');
    if (!planBilling) return res.sendStatus(404);
    try { res.json(await planBilling.webhook(req.body, req.headers)); }
    catch (error) { res.status(error.status || 503).json({ code: error.status ? error.code : 'WEBHOOK_UNAVAILABLE' }); }
}
