import express from 'express';
import rateLimit from 'express-rate-limit';
import protect from '../middleware/auth.middleware.js';
import User from '../models/user.model.js';
import Invitation from '../models/referralInvitation.model.js';
import mailer from '../utils/mailer.js';
import { env } from '../config/env.js';
import { createReferralService } from '../utils/referralService.js';
import { referralQuota } from '../utils/referralPolicy.js';

const config = {
    enabled: env.REFERRALS_ENABLED === 'true',
    mailEnabled: mailer.isConfigured,
    frontend: env.FRONTEND_URL,
    from: mailer.from,
};
const service = createReferralService({ User, Invitation, sendMail: mail => mailer.sendMail({ ...mail, channel: 'accounts' }), config });
const router = express.Router();
router.use(protect, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.use(rateLimit({ windowMs: 60_000, max: 20, keyGenerator: req => String(req.user._id), standardHeaders: true, legacyHeaders: false }));
const handle = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(error.status || 500).json({ code: error.code && error.status ? error.code : 'REFERRAL_UNAVAILABLE' }); }
};
router.get('/me', handle(async req => ({ ...referralQuota(req.user), enabled: config.enabled, mailEnabled: config.mailEnabled,
    canInvite: config.enabled && config.mailEnabled && req.user.isVerified && referralQuota(req.user).remainingInvitations > 0,
    active: config.enabled && !!req.user.referral?.referredBy && !req.user.referral?.rewardedAt,
    hasInvitations: config.enabled && !!await Invitation.exists({ sender: req.user._id, delivery: 'sent', expiresAt: { $gt: new Date() } }),
    rewards: req.user.referral?.count || 0 })));
router.post('/invite', handle(req => service.invite(req.user, req.body.email, req.body.consent)));
router.post('/claim', handle(req => service.claim(req.user, req.body.token)));
router.post('/activity', handle(req => service.activity(req.user, req.body.section)));
export default router;
