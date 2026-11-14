import mongoose from 'mongoose';
import PlanPaymentEvent from './planPaymentEvent.model.js';
export default mongoose.model('LivePaymentEvent', PlanPaymentEvent.schema.clone());
