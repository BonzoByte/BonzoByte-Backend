import crypto from 'node:crypto';

export const DELETION_REASONS = ['not_needed', 'hard_to_use', 'missing_features', 'privacy', 'other'];
export const DELETION_CODE_MS = 10 * 60000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validReceipt = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const deletionError = (code, status = 400) => Object.assign(new Error(code), { code, status });
export function deletionCodeHash(secret, user, challenge, code) {
    return crypto.createHmac('sha256', secret).update(`account-deletion:${user}:${challenge}:${code}`).digest('hex');
}
function equal(a, b) { return typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function deletionMail(email, code, hr = false) {
    return { to: email, subject: hr ? 'BonzoByte — potvrda brisanja računa' : 'BonzoByte — confirm account deletion',
        text: hr ? `Kod za trajno brisanje BonzoByte računa: ${code}\nVrijedi 10 minuta. Samo primanje ove poruke ne briše račun. Upiši kod u aplikaciju i izričito potvrdi brisanje. Ako to nisi zatražio, zanemari poruku. Ne dijeli ovaj kod.`
            : `Your BonzoByte account deletion code: ${code}\nValid for 10 minutes. Receiving this message does not delete your account. Enter the code in the app and explicitly confirm deletion. If you did not request this, ignore this message. Do not share this code.` };
}

// The service has no PayPal or live-email dependency. All destructive work is
// reached only after account-bound, one-use proof and explicit confirmation.
export function createAccountDeletion({ connection, User, Challenge, Job, Aggregate, cleanup,
    purgeAvatars, sendMail, secret, enabled = () => true, now = () => new Date(), externalReviewRequired = true }) {
    const requireEnabled = () => { if (!enabled()) throw deletionError('DELETION_UNAVAILABLE', 503); };
    const read = id => User.findById(id).select('+accountOperations').lean();
    const usable = user => {
        if (!user || user.accountClosure?.requestedAt) throw deletionError('ACCOUNT_CLOSED', 401);
        if (!user.isVerified || !user.email) throw deletionError('DELETION_VERIFY_EMAIL', 403);
    };
    async function requestCode(id, language) {
        requireEnabled(); const user = await read(id); usable(user);
        const at = now(), code = String(crypto.randomInt(1000000)).padStart(6, '0'), challenge = crypto.randomBytes(24).toString('hex');
        const previous = await Challenge.findOne({ user: id }).lean();
        const fresh = !previous?.windowAt || at - previous.windowAt >= 3600000;
        if (previous?.nextSendAt > at || (!fresh && (previous.sends >= 5 || previous.failures >= 10)))
            throw deletionError('DELETION_RATE_LIMIT', 429);
        const fields = { challenge, codeHash: deletionCodeHash(secret(), String(id), challenge, code),
            tokenVersion: user.tokenVersion ?? 0, email: user.email, ready: false, attempts: 0,
            expiresAt: new Date(+at + DELETION_CODE_MS), nextSendAt: new Date(+at + 60000),
            windowAt: fresh ? at : previous.windowAt, sends: fresh ? 1 : previous.sends + 1,
            failures: fresh ? 0 : previous.failures || 0 };
        let reserved;
        try { reserved = await Challenge.findOneAndUpdate({ user: id,
            ...(previous ? { _id: previous._id, challenge: previous.challenge } : { challenge: { $exists: false } }) },
            { $set: fields, $setOnInsert: { user: id } }, { new: true, upsert: !previous }); }
        catch (error) { if (error.code === 11000) throw deletionError('DELETION_RATE_LIMIT', 429); throw error; }
        if (!reserved) throw deletionError('DELETION_RATE_LIMIT', 429);
        try { await sendMail(deletionMail(user.email, code, language === 'hr')); }
        catch { throw deletionError('DELETION_MAIL_FAILED', 503); }
        await Challenge.updateOne({ _id: reserved._id, challenge }, { $set: { ready: true } });
        return { challenge, expiresAt: fields.expiresAt, resendAt: fields.nextSendAt };
    }
    async function confirm(id, input = {}) {
        requireEnabled();
        if (input.confirm !== true || !validReceipt(input.receipt) || typeof input.challenge !== 'string'
            || !/^[a-f0-9]{48}$/.test(input.challenge) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)
            || (input.reason != null && input.reason !== '' && !DELETION_REASONS.includes(input.reason)))
            throw deletionError('DELETION_INVALID_REQUEST');
        // Count failed guesses with CAS outside the confirmation transaction so
        // throwing an error cannot roll back an exhausted attempt counter.
        const proof = await Challenge.findOne({ user: id, challenge: input.challenge }).lean();
        if (!proof?.ready || proof.expiresAt <= now() || proof.attempts >= 5 || proof.failures >= 10)
            throw deletionError('DELETION_CODE_EXPIRED');
        if (!equal(proof.codeHash, deletionCodeHash(secret(), String(id), input.challenge, input.code))) {
            await Challenge.updateOne({ _id: proof._id, challenge: input.challenge, attempts: { $lt: 5 } },
                { $inc: { attempts: 1, failures: 1 } });
            throw deletionError('DELETION_CODE_INVALID');
        }
        await connection.transaction(async session => {
            const user = await User.findById(id).session(session); usable(user);
            if ((user.tokenVersion ?? 0) !== proof.tokenVersion || user.email !== proof.email)
                throw deletionError('DELETION_CODE_EXPIRED');
            const used = await Challenge.deleteOne({ _id: proof._id, challenge: input.challenge,
                ready: true, expiresAt: { $gt: now() }, attempts: { $lt: 5 }, failures: { $lt: 10 } }, { session });
            if (!used.deletedCount) throw deletionError('DELETION_CODE_EXPIRED');
            const at = now();
            const [job] = await Job.create([{ user: user._id, email: user.email, googleId: user.googleId, facebookId: user.facebookId, avatarKey: user.avatarKey,
                legacyAvatar: !user.avatarKey && /\/uploads\//.test(user.avatarUrl || ''),
                receiptHash: hash(input.receipt), requestedAt: at, nextAttemptAt: at,
                month: at.toISOString().slice(0, 7), reason: input.reason || 'unspecified', externalReviewRequired,
            }], { session });
            user.accountClosure = { requestedAt: at, jobId: job._id };
            user.tokenVersion = (user.tokenVersion ?? 0) + 1; user.isOnline = false;
            user.resetPasswordToken = undefined; user.resetPasswordExpires = undefined; user.verification = undefined;
            await user.save({ session });
        });
        return { state: 'queued' };
    }
    async function status(receipt) {
        requireEnabled(); if (!validReceipt(receipt)) throw deletionError('DELETION_INVALID_REQUEST');
        const job = await Job.findOne({ receiptHash: hash(receipt) }).lean();
        return { state: job?.state ?? 'not_found' };
    }
    async function processDue(limit = 2) {
        requireEnabled(); let processed = 0;
        const jobs = await Job.find({ state: 'queued', nextAttemptAt: { $lte: now() } }).sort({ requestedAt: 1 }).limit(Math.min(5, limit)).lean();
        for (const job of jobs) {
            try {
                const user = await read(job.user);
                if (!user?.accountClosure?.requestedAt || String(user.accountClosure.jobId) !== String(job._id))
                    throw deletionError('DELETION_REVIEW_REQUIRED');
                if (user.accountOperations?.some(op => op.expiresAt > now())) throw deletionError('DELETION_WAITING');
                await cleanup.check(user, now());
                if (job.legacyAvatar) throw deletionError('DELETION_LEGACY_AVATAR_REVIEW');
                await purgeAvatars(String(user._id), job.avatarKey); // strict errors: retry after a failed filesystem/R2 operation
                await connection.transaction(async session => {
                    const current = await Job.findOne({ _id: job._id, state: 'queued' }).session(session);
                    if (!current) return;
                    const member = await User.findOne({ _id: job.user, 'accountClosure.jobId': job._id }).session(session);
                    if (!member) throw deletionError('DELETION_REVIEW_REQUIRED');
                    // Serialize against worker grants/refunds and all in-flight account mutations.
                    await User.updateOne({ _id: member._id }, { $inc: { tokenVersion: 1 } }, { session });
                    const providerReferences = await cleanup.erase(member, session);
                    await User.deleteOne({ _id: member._id, 'accountClosure.jobId': job._id }, { session });
                    await Aggregate.updateOne({ _id: job.month }, { $inc: { ['counts.' + job.reason]: 1 } }, { upsert: true, session });
                    const at = now(), external = job.externalReviewRequired;
                    await Job.updateOne({ _id: job._id, state: 'queued' }, { $set: {
                        state: external ? 'app_erased' : 'complete', appErasedAt: at, ...(external ? providerReferences : {}),
                        ...(external ? {} : { completedAt: at, expiresAt: new Date(+at + 7 * 86400000) }),
                    }, $unset: { reason: 1, month: 1, legacyAvatar: 1, failureCode: 1, nextAttemptAt: 1,
                        ...(!external ? { user: 1, email: 1, googleId: 1, facebookId: 1, avatarKey: 1,
                            providerMessageIds: 1, providerPaymentReferences: 1 } : {}) } }, { session });
                });
                processed++;
            } catch (error) {
                const code = /^DELETION_/.test(error.code || '') ? error.code : 'DELETION_RETRY';
                await Job.updateOne({ _id: job._id, state: 'queued' }, { $set: {
                    failureCode: code, nextAttemptAt: new Date(+now() + 60000),
                } });
            }
        }
        return { checked: jobs.length, processed };
    }
    return { requestCode, confirm, status, processDue };
}
