import mongoose from 'mongoose';
const schema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true },
    digest: { type: String, required: true },
    eventType: { type: String, required: true },
    orderId: String,
}, { timestamps: true });
// No TTL: forgetting processed events would weaken replay protection.
export default mongoose.model('BillingLabEvent', schema);
