import mongoose from 'mongoose';
const schema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    requestId: { type: String, required: true },
    plan: { type: String, required: true },
    amount: { type: String, default: '0.01', immutable: true },
    currency: { type: String, default: 'EUR', immutable: true },
    orderId: String, merchantId: String, captureId: String,
    status: { type: String, default: 'created' },
    grantStartedAt: Date, grantEndsAt: Date, revokedAt: Date, revocationReason: String,
    refundId: String, refundStatus: String,
    nextCheckAt: { type: Date, default: Date.now, index: true },
    lastCheckedAt: Date, checkFailures: { type: Number, default: 0 },
}, { timestamps: true });
schema.index({ user: 1, requestId: 1 }, { unique: true });
schema.index({ orderId: 1 }, { unique: true, sparse: true });
schema.index({ captureId: 1 }, { unique: true, sparse: true });
export default mongoose.model('BillingLabPayment', schema);
