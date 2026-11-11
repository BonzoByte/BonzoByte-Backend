// Operator-only fixtures. No HTTP route, mail transport or payment provider calls.
import { DAY_MS } from './paidMembership.js';

export const SOCIAL_TEST_SEED = 'match-discussions-v1';
export const SOCIAL_TEST_DATABASE = 'test'; // Inspected local-development application's database.
export function testAccountEnvironmentAllowed(settings = process.env) {
    try {
        const origin = new URL(settings.FRONTEND_URL || '');
        return ['development', 'test'].includes(settings.NODE_ENV || 'development')
            && (!settings.APP_STAGE || settings.APP_STAGE === 'development')
            && settings.BILLING_LAB_ENABLED !== 'true' && settings.ARCHIVES_ONLY !== 'true'
            && origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    } catch { return false; }
}
export function developmentTestAccountAllowed(user, settings = process.env) {
    return !user?.testAccount || testAccountEnvironmentAllowed(settings);
}
export function assertTestSeedTarget(connection, expectedDatabase, settings = process.env) {
    if (!testAccountEnvironmentAllowed(settings) || expectedDatabase !== SOCIAL_TEST_DATABASE
        || connection.name !== expectedDatabase || settings.PAYPAL_MEMBERSHIP_ENABLED !== 'true')
        throw new Error('Test accounts require the explicit inspected development database, loopback frontend and sandbox membership.');
}
export function testAccountPlan(at = new Date()) {
    if (!Number.isFinite(at.getTime())) throw new Error('Invalid fixture clock.');
    return Array.from({ length: 20 }, (_, offset) => {
        const index = offset + 1, number = String(index).padStart(2, '0');
        const tier = index <= 10 ? 'standard' : index <= 15 ? 'trial' : 'premium';
        const row = { name: `User${number}`, nickname: `user${number}`, email: `bonzobyte+user${number}@gmail.com`,
            createdVia: 'manual', provider: ['local'], isUser: true, isVerified: true, isAdmin: false,
            plan: 'free', testAccount: { seedId: SOCIAL_TEST_SEED, index, tier },
            ads: { enabled: true, disabledReason: 'manual' } };
        if (tier === 'trial') row.trial = { startedAt: at, endsAt: new Date(+at + 7 * DAY_MS),
            grantedDaysTotal: 7, lastGrantedAt: at };
        if (tier === 'premium') row.billingMembership = { version: 1, environment: 'sandbox', baselineAt: at,
            baselineTrialMs: 7 * DAY_MS, trialCredits: [], grants: [{ paymentId: `development-fixture:${SOCIAL_TEST_SEED}:${index}`,
                paidAt: at, durationMs: 30 * DAY_MS, revokedAt: null }] };
        return row;
    });
}
export function pendingTestAccounts(plan, existing) {
    const result = [];
    for (const desired of plan) {
        const collisions = existing.filter(row => row.email?.toLowerCase() === desired.email
            || row.nickname?.toLowerCase() === desired.nickname
            || (row.testAccount?.seedId === SOCIAL_TEST_SEED && row.testAccount.index === desired.testAccount.index));
        if (!collisions.length) { result.push(desired); continue; }
        if (collisions.length !== 1 || collisions[0].testAccount?.seedId !== SOCIAL_TEST_SEED
            || collisions[0].testAccount.index !== desired.testAccount.index || collisions[0].email !== desired.email
            || collisions[0].nickname !== desired.nickname || collisions[0].accountClosure?.requestedAt)
            throw new Error(`Test identity collision for ${desired.name}; no existing account will be overwritten.`);
        // Existing fixtures are intentionally untouched, including passwords, membership and user edits.
    }
    return result;
}
