import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const PLAN = ['free', 'premium'];
const SUB_PROVIDERS = ['none', 'stripe', 'paddle', 'paypal', 'manual'];
const SUB_STATUS = ['none', 'active', 'past_due', 'canceled', 'expired'];
const ADS_DISABLED_REASON = ['premium', 'trial', 'admin', 'manual'];

const userSchema = new mongoose.Schema({
    // Core identity fields.
    name: { type: String, required: true, trim: true },
    nickname: { type: String, trim: true, unique: true, sparse: true },
    email: { type: String, required: false, unique: true, lowercase: true, trim: true },

    // ✅ Autentikacija
    password: {
        type: String,
        required: function () { return !(this.googleId || this.facebookId); },
        select: false
    },

    // ✅ Poveznice / identitet
    country: { type: Number, ref: 'Country' },
    googleId: { type: String, unique: true, sparse: true },
    facebookId: { type: String, unique: true, sparse: true },
    createdVia: { type: String, enum: ['manual', 'google', 'facebook'], default: 'manual' },
    provider: { type: [String], default: [] }, // npr. ['local','google']

    // ✅ Uloge i status
    isAdmin: { type: Boolean, default: false },
    isUser: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },
    presencePrivacy: { type: new mongoose.Schema({ showOnlineStatus: { type: Boolean, default: false } }, { _id: false }), default: undefined },
    competitionPrivacy: { type: new mongoose.Schema({
        shareSettledPicks: { type: Boolean, default: false }, publicId: String, revision: String,
    }, { _id: false }), default: undefined },
    // Only the local operator fixture tool sets this; never accepted by profile/register endpoints.
    testAccount: { type: new mongoose.Schema({ seedId: String, index: Number, tier: String }, { _id: false }), default: undefined },

    // Optional profile metadata.
    avatarUrl: { type: String, default: null },
    avatarKey: { type: String, default: null },
    avatarUpdatedAt: { type: Date, default: null },
    countryTPId: { type: Number, ref: 'Country' },
    gender: { type: String, enum: ['male', 'female', 'other'], default: 'other' },
    dateOfBirth: { type: Date },
    lastLogin: { type: Date },

    // ✅ Player povezivanje
    player1TPId: { type: Number, ref: 'Player' },
    player2TPId: { type: Number, ref: 'Player' },

    // Password-reset state.
    resetPasswordToken: { type: String, select: false, index: true },
    resetPasswordExpires: { type: Date, index: true },
    tokenVersion: { type: Number, default: 0 },
    accountClosure: { type: new mongoose.Schema({ requestedAt: Date, jobId: mongoose.Schema.Types.ObjectId }, { _id: false }), default: undefined },
    accountOperations: { type: [new mongoose.Schema({ id: String, expiresAt: Date }, { _id: false })], default: undefined, select: false },

    // Selected only by verification services; never part of profile/auth payloads.
    verification: { type: new mongoose.Schema({
        revision: String, challenge: String, codeHash: String, linkHash: String,
        expiresAt: Date, resendAt: Date, attempts: Number,
        windowAt: Date, sends: Number, failures: Number,
        delivery: { type: String, enum: ['pending', 'sent', 'failed'] },
    }, { _id: false }), select: false, default: undefined },

    plan: { type: String, enum: PLAN, default: 'free', index: true },

    // Versioned sandbox-only entitlement ledger. No migration from old 0.01 receipts.
    // Dates/credits are replayed without requiring a job to fire exactly at expiry.
    billingMembership: { type: new mongoose.Schema({
        version: { type: Number, required: true },
        environment: { type: String, enum: ['sandbox'], required: true },
        baselineAt: { type: Date, required: true },
        baselineTrialMs: { type: Number, min: 0, required: true },
        trialCredits: { type: [new mongoose.Schema({ at: Date, durationMs: Number, referralId: mongoose.Schema.Types.ObjectId }, { _id: false })], default: [] },
        grants: { type: [new mongoose.Schema({ paymentId: String, paidAt: Date, durationMs: Number, revokedAt: Date }, { _id: false })], default: [] },
    }, { _id: false }), default: undefined },

    trial: {
        startedAt: { type: Date, default: null },
        endsAt: { type: Date, default: null, index: true },
        grantedDaysTotal: { type: Number, default: 0 },
        lastGrantedAt: { type: Date, default: null },
    },

    // Manually assigned access is distinct from administrator permissions.
    vip: {
        enabled: { type: Boolean, default: false },
        grantedAt: { type: Date, default: null },
        source: { type: String, enum: ['manual', 'founders'], default: 'manual' },
    },

    subscription: {
        provider: { type: String, enum: SUB_PROVIDERS, default: 'none' },
        status: { type: String, enum: SUB_STATUS, default: 'none', index: true },
        validUntil: { type: Date, default: null, index: true },
        customerId: { type: String, default: null },
        subscriptionId: { type: String, default: null },
        // Used for Founders Pass and lifetime access.
        isLifetime: { type: Boolean, default: false, index: true },
    },

    ads: {
        enabled: { type: Boolean, default: true, index: true },
        disabledReason: { type: String, enum: ['premium', 'trial', 'admin', 'manual'], default: 'manual' },
    },

    referral: {
        code: { type: String, unique: true, sparse: true, index: true },
        referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
        count: { type: Number, default: 0 },
        lastReferralAt: { type: Date, default: null },
        invitationId: { type: mongoose.Schema.Types.ObjectId, default: null },
        activitySections: { type: [String], default: [] },
        firstActivityAt: { type: Date, default: null },
        rewardedAt: { type: Date, default: null },
        // Reward marker and trial extension are written atomically in this same document.
        rewardedUserIds: { type: [mongoose.Schema.Types.ObjectId], default: [], select: false },
        // Total reserved requests; never reset by elapsed time or expired invitation cleanup.
        invitationsUsed: { type: Number, default: 0, min: 0 },
        emailWindowAt: { type: Date, default: null },
        emailWindowCount: { type: Number, default: 0 },
    },

}, { timestamps: true });

userSchema.index({ 'competitionPrivacy.publicId': 1 }, { unique: true,
    partialFilterExpression: { 'competitionPrivacy.publicId': { $type: 'string' } } });

// Hash a changed password, but never hash an existing bcrypt value again.
userSchema.pre('save', async function (next) {
    try {
        if (!this.isModified('password') || !this.password) return next();

  // Preserve values that already use a recognized bcrypt prefix ($2a/$2b/$2y).
        if (/^\$2[aby]\$/.test(this.password)) return next();

        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

const User = mongoose.model('User', userSchema);
export default User;
