import mongoose from 'mongoose';
import LabPayment from './billingLabPayment.model.js';
// Separate collections prevent old preview/lab receipts from gaining real-duration rights.
const schema = LabPayment.schema.clone();
schema.add({ environment: { type: String, enum: ['sandbox'], default: 'sandbox', immutable: true },
    version: { type: Number, default: 1, immutable: true },
    durationDays: { type: Number, min: 1, max: 365, required: true, immutable: true },
    captureRequestedAt: Date, captureRequestUntil: Date,
    // Only new orders explicitly opted in at creation can generate mail.
    notificationVersion: { type: Number, enum: [1], immutable: true },
    testClockAdjustment: { type: Boolean, default: false },
    testDurationMs: { type: Number, min: 0, max: 365 * 86400000 },
});
export default mongoose.model('PlanPayment', schema);
