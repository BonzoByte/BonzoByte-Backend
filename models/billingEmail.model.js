import mongoose from 'mongoose';
import { MAIL_CHANNELS } from '../utils/mailRouting.js';

const payloadSchema = new mongoose.Schema({
    channel: { type: String, enum: MAIL_CHANNELS },
    from: String, to: [String], replyTo: String, subject: String, text: String, html: String,
}, { _id: false });
const schema = new mongoose.Schema({
    payment: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    kind: { type: String, enum: ['purchase', 'refund'], required: true, immutable: true },
    environment: { type: String, enum: ['sandbox'], required: true, immutable: true },
    idempotencyKey: { type: String, required: true, immutable: true },
    payload: { type: payloadSchema, immutable: true },
    state: { type: String, enum: ['pending', 'sending', 'accepted', 'review'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: Date, firstAttemptAt: Date,
    leaseId: String, leaseUntil: Date,
    acceptedAt: Date, providerMessageId: String,
    failureCode: String,
}, { timestamps: true });
schema.index({ payment: 1, kind: 1 }, { unique: true });
schema.index({ idempotencyKey: 1 }, { unique: true });
schema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });
export default mongoose.model('BillingEmail', schema);
