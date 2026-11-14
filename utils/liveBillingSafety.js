import { billingError } from './paypalSandboxApi.js';
import { BILLING_LAB_DB } from './billingLabSafety.js';
export function requireLiveBilling(config) {
    if (config.enabled !== true || config.sandboxEnabled || config.sandboxPlansEnabled || config.labEnabled || config.archivesOnly
        || !config.clientId || !config.secret || !/^[A-Z0-9]{5,128}$/.test(config.webhookId || '') || config.webhookId === 'WEBHOOK_ID'
        || config.database === BILLING_LAB_DB)
        throw billingError('LIVE_BILLING_ENVIRONMENT_REQUIRED', 503);
}
export function requireLiveBillingDatabase(connection) {
    if (!connection?.db || connection.name === BILLING_LAB_DB || connection.readyState !== 1)
        throw billingError('LIVE_BILLING_DATABASE_REQUIRED', 503);
}
