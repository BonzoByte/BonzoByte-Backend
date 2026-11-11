import mongoose from 'mongoose';
const challengeSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    challengeHash: String, codeHash: String,
    expiresAt: Date, ready: { type: Boolean, default: false }, usedAt: Date,
    attempts: { type: Number, default: 0 }, nextSendAt: Date,
    windowAt: Date, windowCount: { type: Number, default: 0 },
}, { timestamps: true });
challengeSchema.index({ challengeHash: 1 }, { unique: true, sparse: true });
// Keep rate-limit windows after code expiry; expire records after a day.
challengeSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
const sessionSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true },
    email: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
}, { timestamps: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const BetaChallenge = mongoose.model('BetaChallenge', challengeSchema);
export const BetaSession = mongoose.model('BetaSession', sessionSchema);
