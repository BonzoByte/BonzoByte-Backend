import mongoose from 'mongoose';
import User from '../models/user.model.js';
import mailer from './mailer.js';
import { siteInsightsConfig } from './siteInsightsPolicy.js';
import { createSiteInsightsStore } from './siteInsightsStore.js';
import { isBetaAccountAllowed } from './accessPolicy.js';
import { developmentTestAccountAllowed } from './developmentTestAccounts.js';
import { createInsightsIdentity } from './siteInsightsIdentity.js';

const requestedConfig = siteInsightsConfig();
export const insightsConfig = { ...requestedConfig, emailEnabled: requestedConfig.emailEnabled && mailer.provider === 'resend' && mailer.isConfigured };
export const siteInsightsStore = createSiteInsightsStore({ connection: mongoose.connection, User, config: insightsConfig, mailer });
let ready = false;
export const insightsAvailable = () => ready && mongoose.connection.readyState === 1;
// Withdrawal must still work after recording has been disabled. No indexes,
// observation workers or new data collection are needed to remove old rows.
export const insightsPurgeAvailable = () => mongoose.connection.readyState === 1;
export const insightsIdentity = createInsightsIdentity({ User, secret: () => process.env.JWT_SECRET,
    eligible: user => isBetaAccountAllowed(user.email) && developmentTestAccountAllowed(user) });
export async function initializeSiteInsights() {
    if (!insightsConfig.enabled) return;
    try { await siteInsightsStore.initialize(); ready = true; }
    catch { console.warn('[SITE INSIGHTS] initialization unavailable; recording stays disabled and the application continues.'); return; }
    let running = false;
    const run = async () => {
        if (running || !insightsAvailable()) return; running = true;
        try { await siteInsightsStore.observeRegistrations(); await siteInsightsStore.sendRegistrationMail(); }
        catch { console.warn('[SITE INSIGHTS] observation unavailable; will retry without blocking sign-in.'); }
        finally { running = false; }
    };
    const timer = setInterval(() => void run(), 60000); timer.unref(); void run();
}
