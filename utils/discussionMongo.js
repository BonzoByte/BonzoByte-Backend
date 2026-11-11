import { performance } from 'node:perf_hooks';
import { discussionError } from './discussions.js';

export const DISCUSSION_MONGO_LIMITS = Object.freeze({
    initializeMS: 45000,
    helloMS: 5000, helloTimeoutMS: 5000,
    indexMS: 30000, indexTimeoutMS: 30000,
    transactionMS: 20000, commitMS: 20000,
    commandMS: 20000, readTimeoutMS: 5000,
});
export const discussionMonotonicNow = () => performance.now();
export function discussionTimeRemaining(start, budget, clock = discussionMonotonicNow) {
    const remaining = Math.ceil(budget - (clock() - start));
    if (remaining <= 0) {
        const error = discussionError('UNAVAILABLE'); error.name = 'DiscussionTimeoutError'; throw error;
    }
    return remaining;
}
const errorCategory = error => {
    if (['DiscussionTimeoutError', 'MongoOperationTimeoutError', 'MongoNetworkTimeoutError'].includes(error?.name)) return 'timeout';
    if (error?.code === 50) return 'command-timeout';
    if (error?.code === 11000) return 'duplicate-key';
    if (error?.code === 112) return 'write-conflict';
    if (error?.name === 'MongoServerSelectionError') return 'server-selection';
    if (/^DISCUSSIONS_/.test(error?.code || '')) return 'rejected';
    return 'error';
};
// No exception messages, URIs, queries, IDs, request keys, or document content.
// Telemetry failures must never change a successfully committed operation.
export function discussionDiagnostic(notify, operation, elapsedMs, error, attempts = 1) {
    try { notify({ operation, elapsedMs: Math.max(0, Math.round(elapsedMs)), attempts,
        outcome: error ? 'failed' : 'ok', category: error ? errorCategory(error) : 'ok' }); } catch { /* Observer only. */ }
}

export async function initializeDiscussionIndexes({ connection, models, diagnostic = () => {}, clock = discussionMonotonicNow }) {
    if (models.length !== 5) throw new Error('All discussion indexes required');
    const started = clock(), limits = DISCUSSION_MONGO_LIMITS;
    async function step(operation, work) {
        const start = clock();
        try { const result = await work(); discussionDiagnostic(diagnostic, operation, clock() - start); return result; }
        catch (error) { discussionDiagnostic(diagnostic, operation, clock() - start, error); throw error; }
    }
    const remaining = () => discussionTimeRemaining(started, limits.initializeMS, clock);
    const hello = await step('initialize.hello', () => connection.db.admin().command(
        { hello: 1, maxTimeMS: Math.min(limits.helloMS, remaining()) },
        { timeoutMS: Math.min(limits.helloTimeoutMS, remaining()) }));
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Transactions required');
    for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const indexes = model.schema.indexes().map(([key, settings]) => {
            const { _autoIndex, ...options } = settings;
            return { key, ...options };
        });
        // Ensure even index-free thread/spam collections exist BEFORE concurrent
        // transactions, without Mongoose autoCreate or first-write creation races.
        if (!indexes.length) indexes.push({ key: { _id: 1 }, name: '_id_' });
        await step(`initialize.indexes.${i + 1}`, () => {
            const timeoutMS = Math.min(limits.indexTimeoutMS, remaining());
            // Native driver API, not Model.createIndexes(): Mongoose discards
            // call-level maxTimeMS there. CSOT also bounds selection/pool/network.
            // Driver 6.15 replaces maxTimeMS with remaining CSOT: keep the
            // client ceiling no larger than the intended server ceiling.
            return connection.db.collection(model.collection.name).createIndexes(indexes, {
                maxTimeMS: Math.min(limits.indexMS, timeoutMS), timeoutMS,
            });
        });
    }
    remaining(); // A delayed final completion cannot mark an expired init ready.
}
