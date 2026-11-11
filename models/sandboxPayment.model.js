import mongoose from 'mongoose';
const schema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, required: true },
    requestId: { type: String, required: true },
    plan: { type: String, required: true },
    amount: { type: String, default: '0.01' },
    currency: { type: String, default: 'EUR' },
    orderId: { type: String, default: null },
    captureId: { type: String, default: null },
    merchantId: { type: String, default: null },
    status: { type: String, enum: ['created', 'approved', 'pending', 'completed', 'refunded', 'partially_refunded', 'failed', 'cancelled'], default: 'created' },
    lastCheckedAt: { type: Date, default: null },
    // Isolated UI simulation only. Never copied to User.subscription or entitlements.
    membershipPreview: {
        startedAt: { type: Date, default: null },
        endsAt: { type: Date, default: null },
    },
}, { timestamps: true });
schema.index({ user: 1, requestId: 1 }, { unique: true });
export default mongoose.model('SandboxPayment', schema);
