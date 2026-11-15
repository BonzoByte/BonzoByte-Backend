import assert from 'node:assert/strict';
import { MONGO_AVATAR_COLLECTION } from '../../services/avatarStorage/mongoAvatarStorage.js';

export const AVATAR_USER = '0123456789abcdef01234567';
export const OTHER_AVATAR_USER = 'abcdef0123456789abcdef01';

// No sockets or real account objects: a transactional in-memory collection double.
export function mongoAvatarFixture() {
    const state = { images: new Map(), users: new Map([[AVATAR_USER, { _id: AVATAR_USER }]]), calls: [], transactions: 0 };
    let readHook;
    const connection = { readyState: 1, db: { collection(name) {
        assert.ok(['users', MONGO_AVATAR_COLLECTION].includes(name));
        const rows = name === 'users' ? state.users : state.images;
        return {
            async findOne(filter, options) {
                state.calls.push({ name, op: 'findOne', filter, options });
                assert.ok(options.session || options.timeoutMS === 5000);
                const row = rows.get(String(filter._id));
                if (!row || (filter.avatarKey && row.avatarKey !== filter.avatarKey) || (filter.key && row.key !== filter.key)) return null;
                if (name === 'users' && row.accountClosure?.requestedAt !== undefined) return null;
                if (name !== 'users') {
                    assert.ok(filter.$expr); assert.equal(options.promoteBuffers, true);
                    if (!Buffer.isBuffer(row.data) || row.data.length !== row.byteLength
                        || row.byteLength < filter.byteLength.$gte || row.byteLength > filter.byteLength.$lte) return null;
                    if (readHook) await readHook();
                }
                return { ...row };
            },
            async replaceOne(filter, document, options) {
                assert.ok(options.session); assert.equal(options.upsert, true);
                state.calls.push({ name, op: 'replaceOne', filter, options });
                rows.set(filter._id, { ...document, data: Buffer.from(document.data) });
            },
            async deleteOne(filter, options) {
                state.calls.push({ name, op: 'deleteOne', filter, options });
                if (rows.get(filter._id)?.key === filter.key) rows.delete(filter._id);
            },
            async deleteMany(filter, options) {
                state.calls.push({ name, op: 'deleteMany', filter, options });
                rows.delete(filter._id);
            },
        };
    } }, async transaction(fn, options) {
        state.transactions++;
        assert.equal(options.timeoutMS, 10000); assert.equal(options.writeConcern.w, 'majority');
        const images = new Map(state.images), users = new Map([...state.users].map(([id, row]) => [id, { ...row }]));
        try { return await fn({ inMemory: true }); }
        catch (error) { state.images = images; state.users = users; throw error; }
    } };
    const persist = async (saved, { session }) => {
        assert.ok(session.inMemory);
        state.users.set(AVATAR_USER, { ...state.users.get(AVATAR_USER), avatarKey: saved.key, avatarUrl: saved.publicUrl });
    };
    return { connection, state, persist, onImageRead: hook => { readHook = hook; } };
}
