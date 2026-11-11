const failureCategories = new Map([
    ['MongoServerSelectionError', 'database-selection'],
    ['MongoNetworkError', 'database-network'],
    ['MongoNetworkTimeoutError', 'database-network-timeout'],
    ['MongoServerError', 'database-server'],
    ['MongoNotConnectedError', 'database-disconnected'],
    ['MongoTopologyClosedError', 'database-disconnected'],
    ['MongoOperationTimeoutError', 'database-timeout'],
    ['MongoWaitQueueTimeoutError', 'database-pool-timeout'],
    ['TimeoutError', 'timeout'],
    ['AbortError', 'aborted'],
]);

// Keep error messages, stacks, causes and provider/database payloads out of logs.
// A category identifies the reported failure type, not its underlying root cause.
export function createBillingLabReconciliationRunner({ reconcile, logger = console, now = () => new Date(), label = 'BILLING LAB' }) {
    let running = false;
    let unavailable = false;
    return async () => {
        if (running) return;
        running = true;
        try {
            const result = await reconcile();
            if (unavailable) logger.log(`[${label}] ${now().toISOString()} reconciliation scan available again.`);
            unavailable = false;
            if (result.checked) logger.log(`[${label}] reconciled ${result.succeeded}/${result.checked}`);
        } catch (error) {
            unavailable = true;
            const category = failureCategories.get(error?.name) || 'unknown';
            logger.warn(`[${label}] ${now().toISOString()} reconciliation unavailable (category=${category}); retrying next minute.`);
        } finally { running = false; }
    };
}
