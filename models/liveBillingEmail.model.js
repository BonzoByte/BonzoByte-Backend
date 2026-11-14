import mongoose from 'mongoose';
import BillingEmail from './billingEmail.model.js';
const schema = BillingEmail.schema.clone();
schema.remove('environment');
schema.add({ environment: { type: String, enum: ['live'], required: true, immutable: true } });
export default mongoose.model('LiveBillingEmail', schema);
