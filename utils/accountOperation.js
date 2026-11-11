import crypto from 'node:crypto';

// Drain already-authorized writes before erasure, including requests on another
// server instance. A crashed instance releases its leases through their expiry.
export async function beginAccountOperation(User, req, res, id, tokenVersion) {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) || /\/deletion\/confirm\/?$/.test((req.baseUrl || '') + (req.path || ''))) return true;
    if (res.writableEnded || res.destroyed) return false;
    const operation = crypto.randomUUID(), at = new Date(), expiry = () => new Date(Date.now() + 120000);
    const version = tokenVersion === 0 ? { $or: [{ tokenVersion: 0 }, { tokenVersion: null }] } : { tokenVersion };
    const claimed = await User.collection.updateOne({ _id: id, ...version,
        'accountClosure.requestedAt': { $exists: false } }, [{ $set: { accountOperations: { $concatArrays: [
            { $filter: { input: { $ifNull: ['$accountOperations', []] }, as: 'op', cond: { $gt: ['$$op.expiresAt', at] } } },
            [{ id: operation, expiresAt: expiry() }],
        ] } } }]);
    if (!claimed.matchedCount) return false;
    // A bounded endpoint (or disconnected client) may finish while the claim is
    // in flight. No future finish event will release a late lease, so do it now.
    if (res.writableEnded || res.destroyed) {
        await User.collection.updateOne({ _id: id }, { $pull: { accountOperations: { id: operation } } }).catch(() => {});
        return false;
    }
    // Internal proof for transactional services; never serialized to clients.
    req.accountOperation = { id: operation, tokenVersion };
    const timer = setInterval(() => {
        void User.collection.updateOne({ _id: id, 'accountOperations.id': operation },
            { $set: { 'accountOperations.$.expiresAt': expiry() } }).catch(() => {});
    }, 30000); timer.unref();
    res.once('finish', () => {
        clearInterval(timer);
        void User.collection.updateOne({ _id: id }, { $pull: { accountOperations: { id: operation } } }).catch(() => {});
    });
    // Do not erase a lease immediately on a disconnected client: its handler may
    // still be completing a bounded provider request.
    res.once('close', () => clearInterval(timer));
    return true;
}
