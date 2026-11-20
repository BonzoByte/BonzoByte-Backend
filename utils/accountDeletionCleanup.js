import { deletionError } from './accountDeletion.js';
import { eraseDiscussions } from './discussionCleanup.js';
import { PRIVATE_MESSAGE_COLLECTIONS } from '../models/privateMessages.model.js';
import { erasePrivateMessages } from './privateMessagesCleanup.js';
import { ARCADE_COLLECTIONS } from './arcade.js';
import { FANTASY_COLLECTIONS } from './fantasyPolicy.js';
import { MONGO_AVATAR_COLLECTION } from '../services/avatarStorage/mongoAvatarStorage.js';
import { insightsHash } from './siteInsightsPolicy.js';

export const ACCOUNT_COLLECTIONS = {
    ...ARCADE_COLLECTIONS,
    ...FANTASY_COLLECTIONS,
    ...PRIVATE_MESSAGE_COLLECTIONS,
    users: 'users', siteRegistrations: 'siteinsights_registrations', siteVisits: 'siteinsights_visits', avatars: MONGO_AVATAR_COLLECTION, favourites: 'favouriteplayers', matches: 'favouritematches', picks: 'picks', competition: 'competitionpicks',
    invitations: 'referralinvitations', payments: 'planpayments', events: 'planpaymentevents',
    livePayments: 'livepayments',
    previews: 'sandboxpayments', labPayments: 'billinglabpayments', labEvents: 'billinglabevents',
    mail: 'billingemails', challenges: 'deletionchallenges', betaChallenges: 'betachallenges', betaSessions: 'betasessions',
    popularityDevelopment: 'popularity_development_dedupe', popularitySandbox: 'popularity_sandbox_dedupe',
    popularityProduction: 'popularity_production_dedupe',
    discussionComments: 'discussioncomments', discussionThreads: 'discussionthreads',
    discussionStates: 'discussionstates', discussionReports: 'discussionreports', discussionSpam: 'discussionspam',
};
export function createDeletionCleanup(connection, names = ACCOUNT_COLLECTIONS) {
    const c = key => connection.collection(names[key]);
    const payments = async (user, options = {}) => (await Promise.all(['payments', 'previews', 'labPayments']
        .map(key => c(key).find({ user: user._id }, options).toArray()))).flat();
    async function check(user, at) {
        // Real financial receipts require a retention/refund review, never the
        // automatic Sandbox cleanup or a silent loss of financial evidence.
        if (user.subscription?.provider && user.subscription.provider !== 'none' && user.subscription.subscriptionId !== 'billing-lab')
            throw deletionError('DELETION_RETENTION_REVIEW');
        if (names.livePayments && await c('livePayments').findOne({ user: user._id }))
            throw deletionError('DELETION_RETENTION_REVIEW');
        const plans = await c('payments').find({ user: user._id }).toArray();
        if (plans.some(p => p.environment !== 'sandbox')) throw deletionError('DELETION_RETENTION_REVIEW');
        const rows = await payments(user);
        if (rows.some(p => p.status === 'pending' || p.refundStatus === 'PENDING' || p.captureRequestUntil > at))
            throw deletionError('DELETION_PAYMENT_REVIEW');
        if (await c('mail').findOne({ payment: { $in: rows.map(p => p._id) }, state: 'sending', leaseUntil: { $gt: at } }))
            throw deletionError('DELETION_WAITING');
        if (await c('siteRegistrations').findOne({ userId: user._id, emailState: 'sending', leaseUntil: { $gt: at } }))
            throw deletionError('DELETION_WAITING');
        if (String(process.env.SITE_INSIGHTS_SECRET || '').length < 32
            && await c('siteVisits').findOne({ members: { $exists: true, $ne: [] } }))
            throw deletionError('DELETION_REVIEW_REQUIRED');
    }
    async function erase(user, session) {
        const options = { session }, rows = await payments(user, options);
        // Also erase Mongo images after switching back to another driver.
        await c('avatars').deleteMany({ _id: String(user._id) }, options);
        // Keep only an unlinked signup count; do not retain the erased account ID or send pending owner mail.
        await c('siteRegistrations').updateMany({ userId: user._id }, {
            $unset: { userId: '', lease: '', leaseUntil: '', nextAttemptAt: '' }, $set: { emailState: 'suppressed' },
        }, options);
        const insightsSecret = String(process.env.SITE_INSIGHTS_SECRET || '');
        if (insightsSecret.length >= 32) {
            const memberHash = insightsHash(insightsSecret, 'member', String(user._id));
            await c('siteVisits').updateMany({ members: memberHash }, { $pull: { members: memberHash } }, options);
        }
        const ids = rows.map(p => p._id), orderIds = rows.map(p => p.orderId).filter(Boolean);
        const notifications = await c('mail').find({ payment: { $in: ids } }, options).toArray();
        // No retained payment IDs/digests are treated as anonymous statistics.
        for (const key of ['favourites', 'matches', 'picks', 'competition', 'arcadeProfiles', 'arcadeSeasons', 'arcadeSessions', 'fantasyTeams', 'fantasyLedger', 'fantasyAwards']) await c(key).deleteMany({ userId: user._id }, options);
        await eraseDiscussions(connection, user._id, session, {
            comments: names.discussionComments, threads: names.discussionThreads, states: names.discussionStates,
            reports: names.discussionReports, spam: names.discussionSpam,
        });
        await erasePrivateMessages(connection, user._id, session, names);
        const invitations = await c('invitations').find({ $or: [{ sender: user._id }, { recipientEmail: user.email }] }, options).toArray();
        const invitationIds = invitations.map(i => i._id);
        await c('invitations').deleteMany({ _id: { $in: invitationIds } }, options);
        await c('users').updateMany({ 'referral.referredBy': user._id }, { $set: { 'referral.referredBy': null } }, options);
        await c('users').updateMany({ 'referral.invitationId': { $in: invitationIds } }, { $set: { 'referral.invitationId': null } }, options);
        await c('users').updateMany({ 'referral.rewardedUserIds': user._id }, { $pull: { 'referral.rewardedUserIds': user._id } }, options);
        // Preserve earned time for OTHER users; remove only the identifying link.
        await c('users').updateMany({ 'billingMembership.trialCredits.referralId': user._id },
            { $unset: { 'billingMembership.trialCredits.$[credit].referralId': '' } },
            { ...options, arrayFilters: [{ 'credit.referralId': user._id }] });
        await c('users').updateMany({ 'liveBillingMembership.trialCredits.referralId': user._id },
            { $unset: { 'liveBillingMembership.trialCredits.$[credit].referralId': '' } },
            { ...options, arrayFilters: [{ 'credit.referralId': user._id }] });
        await c('users').updateMany({ 'earnedMembership.trialCredits.referralId': user._id },
            { $unset: { 'earnedMembership.trialCredits.$[credit].referralId': '' } },
            { ...options, arrayFilters: [{ 'credit.referralId': user._id }] });
        for (const key of ['payments', 'previews', 'labPayments']) await c(key).deleteMany({ user: user._id }, options);
        for (const key of ['events', 'labEvents']) await c(key).deleteMany({ orderId: { $in: orderIds } }, options);
        await c('mail').deleteMany({ payment: { $in: ids } }, options);
        await c('challenges').deleteMany({ user: user._id }, options);
        for (const key of ['betaChallenges', 'betaSessions']) await c(key).deleteMany({ email: user.email }, options);
        // Temporary user-linked dedupe only. Daily counters contain no user link
        // and cannot honestly be attributed back to (or subtracted for) a user.
        for (const key of ['popularityDevelopment', 'popularitySandbox', 'popularityProduction'])
            await c(key).deleteMany({ user: user._id }, options);
        return {
            providerMessageIds: notifications.map(row => row.providerMessageId).filter(Boolean),
            providerPaymentReferences: rows.filter(row => row.orderId || row.captureId || row.refundId)
                .map(({ orderId, captureId, refundId }) => ({ orderId, captureId, refundId })),
        };
    }
    return { check, erase };
}
