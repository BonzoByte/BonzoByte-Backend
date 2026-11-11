import crypto from 'node:crypto';
import { REFERRAL_INVITATION_LIMIT, referralInvitationsUsedExpression, REFERRAL_SECTIONS, canonicalEmail, normalizeEmail, tokenHash,
    validReferralToken, canClaimInvitation, isReferralQualified, referralRewardPipeline, referralLink,
    invitationMail, referralError } from './referralPolicy.js';

export function createReferralService({ User, Invitation, sendMail, config, now = () => new Date() }) {
    const requireEnabled = () => { if (!config.enabled) throw referralError('REFERRALS_DISABLED', 503); };
    return {
        async invite(sender, email, consent) {
            requireEnabled();
            if (!sender.isVerified) throw referralError('VERIFICATION_REQUIRED', 403);
            if (!config.mailEnabled) throw referralError('REFERRAL_MAIL_UNAVAILABLE', 503);
            const recipientEmail = normalizeEmail(email);
            if (consent !== true || recipientEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipientEmail))
                throw referralError('INVALID_INVITATION');
            if (canonicalEmail(recipientEmail) === canonicalEmail(sender.email)) throw referralError('SELF_REFERRAL');
            const time = now();
            // Reserve before looking up recipients or contacting the mail provider. Count even duplicates,
            // existing accounts and uncertain delivery: recipient checks are also quota-bound.
            const reserved = await User.updateOne({ _id: sender._id, isVerified: true,
                $expr: { $lt: [referralInvitationsUsedExpression, REFERRAL_INVITATION_LIMIT] },
            }, [{ $set: {
                'referral.invitationsUsed': { $add: [referralInvitationsUsedExpression, 1] },
            } }]);
            if (!reserved.matchedCount) throw referralError('INVITATION_LIMIT', 429);
            // An explicit UI explanation is allowed only AFTER verified auth and quota reservation.
            // Do not add an unmetered recipient-existence endpoint.
            if (await User.exists({ email: recipientEmail })) throw referralError('RECIPIENT_ALREADY_REGISTERED', 409);
            await Invitation.deleteOne({ sender: sender._id, recipientEmail, $or: [
                { delivery: 'failed' }, { expiresAt: { $lte: time } },
            ] });
            const token = crypto.randomBytes(32).toString('hex');
            let invitation;
            try {
                invitation = await Invitation.create({ sender: sender._id, recipientEmail, tokenHash: tokenHash(token),
                    expiresAt: new Date(time.getTime() + 30 * 86400000) });
            } catch (error) {
                if (error.code === 11000) return { accepted: true, delivery: 'duplicate', recipientEmail };
                throw error;
            }
            try {
                const result = await sendMail(invitationMail({ to: recipientEmail,
                    senderName: sender.nickname || sender.name || 'A friend',
                    link: referralLink(config.frontend, token), from: config.from }));
                if (result?.rejected?.length) throw referralError('REFERRAL_MAIL_UNAVAILABLE', 503);
                await Invitation.updateOne({ _id: invitation._id }, { $set: { delivery: 'sent' } });
            } catch {
                await Invitation.updateOne({ _id: invitation._id }, { $set: { delivery: 'failed' } });
                throw referralError('REFERRAL_MAIL_UNAVAILABLE', 503);
            }
            // Provider acceptance is not a guarantee of inbox placement. Distinguish it from
            // duplicate requests that did not send a new message.
            return { accepted: true, delivery: 'sent', recipientEmail };
        },
        async claim(user, token) {
            requireEnabled();
            if (!validReferralToken(token)) throw referralError('INVALID_REFERRAL');
            const invitation = await Invitation.findOne({ tokenHash: tokenHash(token) });
            if (invitation && String(user.referral?.invitationId) === String(invitation._id)) return { active: true };
            const sender = invitation ? await User.findById(invitation.sender) : null;
            if (!canClaimInvitation(invitation, user, sender, now())) throw referralError('INVALID_REFERRAL');
            const result = await User.updateOne({ _id: user._id, 'referral.referredBy': null }, { $set: {
                'referral.referredBy': invitation.sender, 'referral.invitationId': invitation._id,
            } });
            if (!result.matchedCount) throw referralError('INVALID_REFERRAL');
            return { active: true };
        },
        async activity(user, section) {
            requireEnabled();
            if (!user.isVerified) throw referralError('VERIFICATION_REQUIRED', 403);
            if (!REFERRAL_SECTIONS.includes(section)) throw referralError('INVALID_SECTION');
            if (!user.referral?.referredBy || user.referral.rewardedAt) return { active: false };
            const time = now();
            const updated = await User.findOneAndUpdate({ _id: user._id, 'referral.rewardedAt': null }, [{ $set: {
                'referral.firstActivityAt': { $ifNull: ['$referral.firstActivityAt', time] },
                'referral.activitySections': { $setUnion: [{ $ifNull: ['$referral.activitySections', []] }, [section]] },
            } }], { new: true });
            if (!updated || !isReferralQualified(updated, time)) return { active: !!updated };
            const senderId = updated.referral.referredBy;
            if (String(senderId) === String(updated._id)) throw referralError('SELF_REFERRAL');
            // Exactly-once credit: the marker and +7 days share ONE atomic document update.
            await User.updateOne({ _id: senderId, isVerified: true, 'referral.rewardedUserIds': { $ne: updated._id } },
                referralRewardPipeline(updated._id, time));
            // Recover even if an earlier request committed the reward then lost its connection.
            const credited = await User.exists({ _id: senderId, 'referral.rewardedUserIds': updated._id });
            if (!credited) return { active: true };
            await User.updateOne({ _id: updated._id, 'referral.rewardedAt': null }, { $set: { 'referral.rewardedAt': time } });
            return { active: false, qualified: true };
        },
    };
}
