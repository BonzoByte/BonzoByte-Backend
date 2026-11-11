import mongoose from 'mongoose';
import LabEvent from './billingLabEvent.model.js';
export default mongoose.model('PlanPaymentEvent', LabEvent.schema.clone());
