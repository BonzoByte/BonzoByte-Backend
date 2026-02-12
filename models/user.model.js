import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const PLAN = ['free', 'premium'];
const SUB_PROVIDERS = ['none', 'stripe', 'paddle', 'paypal', 'manual'];
const SUB_STATUS = ['none', 'active', 'past_due', 'canceled', 'expired'];
const ADS_DISABLED_REASON = ['premium', 'trial', 'admin', 'manual'];

const userSchema = new mongoose.Schema({
    // ✅ Osnovni podaci
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

    // ✅ Dodatni info
    avatarUrl: { type: String, default: null },
    countryTPId: { type: Number, ref: 'Country' },
    gender: { type: String, enum: ['male', 'female', 'other'], default: 'other' },
    dateOfBirth: { type: Date },
    lastLogin: { type: Date },

    // ✅ Player povezivanje
    player1TPId: { type: Number, ref: 'Player' },
    player2TPId: { type: Number, ref: 'Player' },

    // ✅ Reset lozinke
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    tokenVersion: { type: Number, default: 0 },

    plan: { type: String, enum: PLAN, default: 'free', index: true },

    trial: {
        endsAt: { type: Date, default: null, index: true },
        grantedDaysTotal: { type: Number, default: 0 },
        lastGrantedAt: { type: Date, default: null },
    },

    subscription: {
        provider: { type: String, enum: SUB_PROVIDERS, default: 'none' },
        status: { type: String, enum: SUB_STATUS, default: 'none', index: true },
        validUntil: { type: Date, default: null, index: true },
        customerId: { type: String, default: null },
        subscriptionId: { type: String, default: null },
        // za “Founders Pass / lifetime”
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
    },

}, { timestamps: true });

// 🛡️ Hash lozinke (ako je promijenjena) - ali NE hashiraj ako je već bcrypt hash
userSchema.pre('save', async function (next) {
    try {
        if (!this.isModified('password') || !this.password) return next();

        // Ako već izgleda kao bcrypt hash ($2a/$2b/$2y), preskoči hashing
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