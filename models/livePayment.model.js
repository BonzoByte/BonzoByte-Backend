import mongoose from 'mongoose';
import PlanPayment from './planPayment.model.js';
const schema = PlanPayment.schema.clone();
schema.remove(['environment', 'testClockAdjustment', 'testDurationMs']);
schema.add({ environment: { type: String, enum: ['live'], default: 'live', required: true, immutable: true } });
export default mongoose.model('LivePayment', schema);
