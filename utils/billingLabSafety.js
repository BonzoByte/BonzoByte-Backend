export const BILLING_LAB_DB = 'BonzoByte_BillingSandbox';
export const BILLING_LAB_DURATION_MS = 5 * 60_000;

// This mode must never write memberships in the normal application's database.
export function assertBillingLabEnvironment(settings = process.env) {
    if (settings.BILLING_LAB_ENABLED !== 'true') return false;
    if (!['development', 'test'].includes(settings.NODE_ENV)
        || settings.MONGO_DB !== BILLING_LAB_DB || settings.PAYPAL_SANDBOX_ENABLED !== 'true'
        || settings.BILLING_LAB_AUTH_ISOLATED !== 'true' || settings.EMAIL_DISABLED !== '1'
        || settings.REFERRALS_ENABLED !== 'false') {
        throw new Error('Billing lab requires its dedicated database, isolated authentication, sandbox, disabled email/referrals and a non-production environment. Use npm run start:billing-lab.');
    }
    return true;
}

export function assertBillingLabDatabase(connection) {
    if (connection.name !== BILLING_LAB_DB) throw new Error('BILLING_LAB_DATABASE_REQUIRED');
}
