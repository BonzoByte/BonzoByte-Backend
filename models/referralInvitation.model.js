import mongoose from 'mongoose';

const schema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipientEmail: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    delivery: { type: String, enum: ['sending', 'sent', 'failed'], default: 'sending' },
    expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });
schema.index({ sender: 1, recipientEmail: 1 }, { unique: true });
export default mongoose.model('ReferralInvitation', schema);
