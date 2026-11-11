import mongoose from 'mongoose';

const challenge = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    challenge: String, codeHash: String, tokenVersion: Number, email: String,
    ready: Boolean, expiresAt: Date, nextSendAt: Date, windowAt: Date,
    sends: Number, attempts: Number, failures: Number,
}, { timestamps: true });
challenge.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
const job = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, unique: true, sparse: true },
    receiptHash: { type: String, required: true, unique: true },
    state: { type: String, enum: ['queued', 'app_erased', 'complete'], default: 'queued' },
    email: String, googleId: String, facebookId: String, avatarKey: String, legacyAvatar: Boolean,
    reason: String, month: String, nextAttemptAt: Date, failureCode: String,
    // Only IDs needed to request erasure from processors/backup restoration checks.
    providerMessageIds: [String], externalReviewRequired: Boolean,
    providerPaymentReferences: [new mongoose.Schema({ orderId: String, captureId: String, refundId: String }, { _id: false })],
    requestedAt: Date, appErasedAt: Date, completedAt: Date, expiresAt: Date,
    // Operator-only permission to create a NEW account; not external-erasure completion.
    registrationReleasedAt: Date,
}, { versionKey: false });
job.index({ nextAttemptAt: 1 });
job.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const aggregate = new mongoose.Schema({ _id: String, counts: { type: Map, of: Number } }, { versionKey: false });
export const DeletionChallenge = mongoose.model('DeletionChallenge', challenge);
export const DeletionJob = mongoose.model('DeletionJob', job);
export const DepartureAggregate = mongoose.model('DepartureAggregate', aggregate);
