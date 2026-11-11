import mongoose from 'mongoose';
import { env } from '../config/env.js';
import User from '../models/user.model.js';
import { DeletionChallenge as Challenge, DeletionJob as Job, DepartureAggregate as Aggregate } from '../models/accountDeletion.model.js';
import { createAccountDeletion } from './accountDeletion.js';
import { createDeletionCleanup } from './accountDeletionCleanup.js';
import { purgeUserAvatars } from '../services/avatarStorage/index.js';
import mailer from './mailer.js';

let ready = false, running = false;
export const deletion = createAccountDeletion({ connection: mongoose.connection, User, Challenge, Job, Aggregate,
    cleanup: createDeletionCleanup(mongoose.connection), purgeAvatars: purgeUserAvatars,
    sendMail: mail => mailer.sendMail({ ...mail, channel: 'accounts' }), secret: () => env.JWT_SECRET,
    enabled: () => ready, externalReviewRequired: true,
});
export function deletionAvailable() { return ready && mailer.isConfigured; }
export async function runAccountDeletion() {
    if (!ready || running) return;
    running = true;
    try { await deletion.processDue(); }
    catch { console.warn('[ACCOUNT DELETION] cleanup will retry; no personal details logged.'); }
    finally { running = false; }
}
export async function initializeAccountDeletion() {
    if (process.env.BILLING_LAB_ENABLED === 'true') return;
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
        console.warn('[ACCOUNT DELETION] unavailable: MongoDB transactions required.'); return;
    }
    await Promise.all([Challenge.init(), Job.init(), Aggregate.init()]);
    ready = true;
    const timer = setInterval(() => void runAccountDeletion(), 15000); timer.unref();
    void runAccountDeletion();
}
