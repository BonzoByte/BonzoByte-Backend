import { deletionError } from './accountDeletion.js';

// Operator-only attestation, never an HTTP endpoint. This does not itself erase
// anything at a provider or in a backup: those actions must already be verified.
export async function completeDeletionReview(Job, id, checks, at = new Date()) {
    if (!/^[a-f0-9]{24}$/.test(String(id)) || checks?.providers !== true
        || checks?.backups !== true || checks?.billing !== true)
        throw deletionError('DELETION_REVIEW_INCOMPLETE');
    const result = await Job.updateOne({ _id: id, state: 'app_erased' }, {
        $set: { state: 'complete', completedAt: at, expiresAt: new Date(+at + 7 * 86400000) },
        $unset: { user: 1, email: 1, googleId: 1, facebookId: 1, providerMessageIds: 1, providerPaymentReferences: 1,
            reason: 1, month: 1, avatarKey: 1, legacyAvatar: 1, failureCode: 1, nextAttemptAt: 1, registrationReleasedAt: 1 },
    });
    if (!result.matchedCount) throw deletionError('DELETION_REVIEW_NOT_READY');
    return { state: 'complete' };
}

// Operator-only and deliberately NOT completeDeletionReview: keep the external
// erasure case and all required provider references open. Never restore a user.
export async function releaseDeletedAccountRegistration({ Job, User }, id, checks, at = new Date()) {
    if (!/^[a-f0-9]{24}$/.test(String(id)) || !(at instanceof Date) || !Number.isFinite(+at)
        || checks?.allowNewAccount !== true || checks?.applicationErased !== true
        || checks?.billingReviewed !== true || checks?.applicationBackupsReviewed !== true
        || checks?.externalErasurePending !== true)
        throw deletionError('DELETION_REVIEW_INCOMPLETE');
    const job = await Job.findOne({ _id: id, state: 'app_erased' }).lean();
    if (!job || !(job.appErasedAt instanceof Date) || !Number.isFinite(+job.appErasedAt) || job.appErasedAt > at
        || !job.user || typeof job.email !== 'string' || !job.email)
        throw deletionError('DELETION_REVIEW_NOT_READY');
    const identities = [{ _id: job.user }, { email: job.email },
        ...(job.googleId ? [{ googleId: job.googleId }] : []), ...(job.facebookId ? [{ facebookId: job.facebookId }] : [])];
    if (await User.exists({ $or: identities })) throw deletionError('DELETION_ACCOUNT_STILL_EXISTS');
    if (job.registrationReleasedAt instanceof Date && Number.isFinite(+job.registrationReleasedAt) && job.registrationReleasedAt <= at)
        return { state: 'app_erased', registrationReleased: true, registrationReleasedAt: job.registrationReleasedAt };
    const result = await Job.updateOne({ _id: id, state: 'app_erased', user: job.user, email: job.email,
        appErasedAt: job.appErasedAt, registrationReleasedAt: { $exists: false } }, { $set: { registrationReleasedAt: at } });
    if (!result.matchedCount) throw deletionError('DELETION_REVIEW_NOT_READY');
    return { state: 'app_erased', registrationReleased: true, registrationReleasedAt: at };
}
