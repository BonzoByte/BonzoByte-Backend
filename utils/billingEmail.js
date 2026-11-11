import crypto from 'node:crypto';
import { billingEmailContent } from './billingEmailContent.js';

// Resend retains idempotency keys for 24 hours. Stop an hour early, including
// after a crash with an uncertain outcome; never switch to a fresh key or SMTP.
export const BILLING_EMAIL_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 120000;
const MAX_ATTEMPTS = 10;
const safeMailCodes = new Set(['MAIL_DISABLED', 'MAIL_NOT_CONFIGURED', 'MAIL_ADDRESS_INVALID',
    'MAIL_SUBJECT_INVALID', 'MAIL_SENDER_CHANGED', 'MAIL_IDEMPOTENCY_INVALID', 'MAIL_CHANNEL_INVALID']);

export function billingEmailFailure(error, attempts) {
    if (safeMailCodes.has(error?.code)) return { review: true, code: error.code };
    if (error?.providerCode === 'invalid_idempotent_request') return { review: true, code: 'PAYLOAD_CONFLICT' };
    const status = error?.statusCode;
    if (Number.isInteger(status) && status >= 400 && status < 500
        && status !== 429 && !(status === 409 && error?.providerCode === 'concurrent_idempotent_requests'))
        return { review: true, code: `PROVIDER_${status}` };
    if (attempts >= MAX_ATTEMPTS) return { review: true, code: 'RETRY_LIMIT' };
    return { review: false, code: 'DELIVERY_UNCONFIRMED' };
}

export function createBillingEmailQueue({ Outbox, mailer, enabled = false, now = () => new Date(), logger = console,
    canSendPayment = async () => true }) {
    return {
        newOrderFields: enabled ? { notificationVersion: 1 } : {},

        async enqueue({ payment, member, rights, at, session, fullRefundConfirmed = false }) {
            // The marker is immutable and has no default: toggling the setting or
            // deploying this code cannot backfill historical payments.
            if (payment.notificationVersion !== 1 || payment.environment !== 'sandbox') return;
            const kind = payment.revokedAt
                ? (payment.revocationReason === 'refund' && fullRefundConfirmed ? 'refund' : null)
                : (payment.status === 'completed' && payment.grantStartedAt ? 'purchase' : null);
            if (!kind) return;
            const filter = { payment: payment._id, kind };
            if (await Outbox.findOne(filter).session(session)) return;
            let payload, failureCode;
            try {
                if (!member.isVerified) throw Object.assign(new Error(), { code: 'MAIL_ADDRESS_INVALID' });
                payload = mailer.prepareMail({ to: member.email, ...billingEmailContent(kind, payment, rights, at), channel: 'billing' });
                // Empty is explicit: a later default Reply-To must not alter retries.
                payload.replyTo ??= '';
            } catch (error) {
                failureCode = safeMailCodes.has(error?.code) ? error.code : 'SNAPSHOT_INVALID';
            }
            await Outbox.updateOne(filter, { $setOnInsert: {
                ...filter, environment: 'sandbox', idempotencyKey: `bonzobyte/sandbox/${payment._id}/${kind}/v1`,
                payload, state: failureCode ? 'review' : 'pending', failureCode,
                attempts: 0, nextAttemptAt: at, createdAt: at, updatedAt: at,
            } }, { upsert: true, session, timestamps: false });
        },

        async processDue(limit = 1) {
            const result = { checked: 0, succeeded: 0, review: 0 };
            if (!enabled || !mailer.isConfigured || mailer.provider !== 'resend') return result;
            for (let i = 0; i < Math.min(Math.max(limit, 0), 5); i++) {
                const at = now(), leaseId = crypto.randomUUID();
                const row = await Outbox.findOneAndUpdate({ environment: 'sandbox', $or: [
                    { state: 'pending', nextAttemptAt: { $lte: at } },
                    { state: 'sending', leaseUntil: { $lte: at } },
                ] }, [{ $set: { state: 'sending', leaseId, leaseUntil: new Date(at.getTime() + LEASE_MS),
                    firstAttemptAt: { $ifNull: ['$firstAttemptAt', at] },
                    attempts: { $add: [{ $ifNull: ['$attempts', 0] }, 1] }, updatedAt: at,
                } }], { new: true, sort: { createdAt: 1, _id: 1 }, timestamps: false });
                if (!row) break;
                result.checked++;
                const claim = { _id: row._id, state: 'sending', leaseId };
                let failure, accepted;
                if (at.getTime() - row.firstAttemptAt.getTime() >= BILLING_EMAIL_RETRY_WINDOW_MS)
                    failure = { review: true, code: 'IDEMPOTENCY_WINDOW_EXPIRED' };
                else if (row.attempts > MAX_ATTEMPTS) failure = { review: true, code: 'RETRY_LIMIT' };
                else if (!row.payload) failure = { review: true, code: 'SNAPSHOT_INVALID' };
                else if (!await canSendPayment(row.payment)) failure = { review: true, code: 'ACCOUNT_CLOSED' };
                else {
                    try {
                        const payload = row.payload.toObject();
                        accepted = await mailer.sendMail(payload, { idempotencyKey: row.idempotencyKey, expectedFrom: payload.from });
                        if (!accepted?.messageId) throw new Error('Unconfirmed provider response');
                    } catch (error) { failure = billingEmailFailure(error, row.attempts); }
                }
                // Provider delivery is outside the membership transaction. A DB
                // failure here leaves the lease for an identical, safe retry.
                if (failure) {
                    const delay = Math.min(3600000, 60000 * 2 ** Math.min(row.attempts - 1, 6));
                    await Outbox.updateOne(claim, { $set: { state: failure.review ? 'review' : 'pending',
                        failureCode: failure.code, nextAttemptAt: new Date(now().getTime() + delay),
                    }, $unset: { leaseId: 1, leaseUntil: 1 } });
                    if (failure.review) {
                        result.review++;
                        logger.warn(`[BILLING MAIL] manual review required; notification=${row._id}; reason=${failure.code}`);
                    }
                } else {
                    await Outbox.updateOne(claim, { $set: { state: 'accepted', acceptedAt: now(),
                        providerMessageId: accepted.messageId,
                    }, $unset: { leaseId: 1, leaseUntil: 1, failureCode: 1 } });
                    result.succeeded++;
                }
            }
            return result;
        },
    };
}
