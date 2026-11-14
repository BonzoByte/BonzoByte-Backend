import mongoose from 'mongoose';
import { env } from '../config/env.js';
import User from '../models/user.model.js';
import Payment from '../models/livePayment.model.js';
import Event from '../models/livePaymentEvent.model.js';
import Outbox from '../models/liveBillingEmail.model.js';
import mailer from './mailer.js';
import { createBillingEmailQueue } from './billingEmail.js';
import { createBillingLab } from './billingLab.js';
import { createPaypalLiveApi } from './paypalLiveApi.js';
import { createBillingLabReconciliationRunner } from './billingLabReconciliation.js';
import { requireLiveBilling, requireLiveBillingDatabase } from './liveBillingSafety.js';

export const liveBillingEnabled = env.PAYPAL_LIVE_ENABLED === 'true';
export function assertLiveBillingEnvironment() {
    requireLiveBilling({ enabled: liveBillingEnabled, sandboxEnabled: env.PAYPAL_SANDBOX_ENABLED === 'true',
        sandboxPlansEnabled: env.PAYPAL_MEMBERSHIP_ENABLED === 'true', labEnabled: process.env.BILLING_LAB_ENABLED === 'true',
        archivesOnly: String(process.env.ARCHIVES_ONLY || '').toLowerCase() === 'true', database: env.MONGO_DB,
        clientId: env.PAYPAL_LIVE_CLIENT_ID, secret: env.PAYPAL_LIVE_CLIENT_SECRET, webhookId: env.PAYPAL_LIVE_WEBHOOK_ID });
}
if (liveBillingEnabled) assertLiveBillingEnvironment();
const notifications = liveBillingEnabled ? createBillingEmailQueue({ Outbox, mailer, environment: 'live',
    enabled: env.BILLING_EMAIL_ENABLED === 'true', canSendPayment: async id => {
        const payment = await Payment.findById(id).select('user').lean();
        return !!payment && !!await User.exists({ _id: payment.user, 'accountClosure.requestedAt': { $exists: false } });
    } }) : null;
export const liveBilling = liveBillingEnabled ? createBillingLab({ connection: mongoose.connection, Payment, Event, User,
    planMode: true, liveMode: true, assertPlanEnvironment: assertLiveBillingEnvironment, notifications,
    api: createPaypalLiveApi({ enabled: true, clientId: env.PAYPAL_LIVE_CLIENT_ID,
        secret: env.PAYPAL_LIVE_CLIENT_SECRET, webhookId: env.PAYPAL_LIVE_WEBHOOK_ID }),
}) : null;
export async function initializeLiveBilling() {
    if (!liveBilling) return;
    assertLiveBillingEnvironment();
    requireLiveBillingDatabase(mongoose.connection);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Live membership requires MongoDB transactions.');
    await Promise.all([Payment.init(), Event.init(), Outbox.init()]);
    const run = createBillingLabReconciliationRunner({ label: 'LIVE BILLING', reconcile: () => liveBilling.reconcileDue() });
    const timer = setInterval(run, 60000); timer.unref(); void run();
    if (env.BILLING_EMAIL_ENABLED === 'true') {
        const send = createBillingLabReconciliationRunner({ label: 'LIVE BILLING MAIL', reconcile: () => notifications.processDue() });
        const mailTimer = setInterval(send, 15000); mailTimer.unref(); void send();
    }
    console.log('[LIVE BILLING] one-time EUR payments; separate receipts; no automatic renewal.');
}
