import { env, betaEnabled, betaTesters } from '../config/env.js';
import mailer from './mailer.js';
import { createBetaAccess } from './betaAccess.js';
import { createBetaGate } from './betaGate.js';
import { publicSiteAccess } from './accessPolicy.js';
// Do not register beta models (or auto-create their collections) on ordinary dev startup.
const invitedAccess = betaEnabled && !publicSiteAccess(env);
const models = invitedAccess ? await import('../models/betaAccess.model.js') : null;
export const betaAccess = invitedAccess ? createBetaAccess({ Challenge: models.BetaChallenge, Session: models.BetaSession,
    allowedEmails: () => betaTesters, codeSecret: env.BETA_CODE_SECRET, sendMail: message => mailer.sendMail({ ...message, channel: 'accounts' }) }) : null;
export const betaGate = betaEnabled ? createBetaGate({ access: betaAccess, publicOrigin: env.BETA_PUBLIC_ORIGIN,
    publicAccess: publicSiteAccess(env) }) : null;
export async function initializeBeta() {
    if (!betaEnabled) return;
    if (!invitedAccess) {
        console.log('[ACCESS] public browsing enabled; application authentication and origin checks retained.');
        return;
    }
    if (!mailer.isConfigured) throw new Error('Beta access requires configured email delivery.');
    await Promise.all([models.BetaChallenge.init(), models.BetaSession.init()]);
    console.log(`[BETA] private access enabled; approved testers=${betaTesters.size}; OAuth/development bypass disabled.`);
}
