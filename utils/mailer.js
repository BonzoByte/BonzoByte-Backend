import { env } from '../config/env.js';
import { createMailTransport } from './mailTransport.js';

const mailer = createMailTransport(env);
// Configuration status only; authentication/delivery is checked when actually sending.
console.log(`[MAILER] provider=${mailer.provider}; configured=${mailer.isConfigured}`);
export default mailer;
