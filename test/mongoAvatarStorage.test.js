import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createMongoAvatarStorage, MAX_AVATAR_BYTES, MONGO_AVATAR_COLLECTION } from '../services/avatarStorage/mongoAvatarStorage.js';
import { createMongoAvatarRouter } from '../routes/avatar.routes.js';
import { createDeletionCleanup } from '../utils/accountDeletionCleanup.js';
import { mongoAvatarFixture, AVATAR_USER as id, OTHER_AVATAR_USER as other } from './helpers/mongoAvatarFixture.js';

const webp = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#245678' } }).webp().toBuffer();
function fixture() {
    const f = mongoAvatarFixture();
    return { ...f, store: createMongoAvatarStorage({ connection: f.connection }) };
}
const save = (f, version = 1, persist = f.persist) => f.store.saveAvatar(webp,
    { userId: id, version, baseUrl: 'https://backend.example.invalid' }, persist);

test('transaction operations inherit their deadline instead of nesting timeoutMS', async () => {
    const f = fixture(), original = f.connection.db.collection.bind(f.connection.db);
    f.connection.db.collection = name => {
        const collection = original(name);
        return new Proxy(collection, { get(target, key) {
            const value = target[key];
            if (typeof value !== 'function') return value;
            return (...args) => {
                const options = args.at(-1);
                if (options?.session) assert.equal(Object.hasOwn(options, 'timeoutMS'), false);
                return value.apply(target, args);
            };
        } });
    };
    await save(f);
});

test('Mongo opt-in stores one bounded WebP per owner, preserving URL shape across store recreation', async () => {
    const f = fixture();
    const saved = await save(f);
    assert.equal(saved.key, `avatars/${id}/avatar-1.webp`);
    assert.equal(saved.publicUrl, `https://backend.example.invalid/uploads/${saved.key}`);
    assert.equal(f.store.getPublicUrl(null), null);
    for (let version = 2; version <= 6; version++) await save(f, version);
    assert.equal(f.state.images.size, 1);
    assert.equal(f.state.images.get(id).byteLength, webp.length);
    assert.ok(webp.length <= MAX_AVATAR_BYTES);
    const restarted = createMongoAvatarStorage({ connection: f.connection });
    assert.deepEqual((await restarted.readAvatar(f.store.keyFor(id, 6))).buffer, webp);
    assert.equal(await restarted.readAvatar(saved.key), null);
    await restarted.deleteAvatar(saved.key);
    assert.equal(f.state.images.size, 1);
});

test('transaction abort preserves prior photo/reference; a missing reference save also rolls back', async () => {
    const f = fixture(), old = await save(f);
    await assert.rejects(save(f, 2, async () => { throw new Error('synthetic user save failure'); }), /synthetic/);
    assert.equal(f.state.users.get(id).avatarKey, old.key);
    assert.equal(f.state.images.get(id).key, old.key);
    await assert.rejects(save(f, 3, async () => {}), { code: 'AVATAR_REFERENCE_NOT_SAVED' });
    assert.deepEqual((await f.store.readAvatar(old.key)).buffer, webp);
    await assert.rejects(save(f, 1), { code: 'AVATAR_VERSION_CONFLICT' });
    assert.equal(f.state.images.get(id).key, old.key);
    await assert.rejects(f.store.saveAvatar(webp, { userId: id, version: 4 }), { code: 'AVATAR_REFERENCE_REQUIRED' });
});

test('strict canonical keys reject traversal, encoded separators, bad ids and unsafe versions before DB access', async () => {
    const f = fixture();
    for (const bad of ['../avatars', 'avatars/../secret', '/avatars', 'avatars\\secret', 'avatars/%2e%2e', 'a'.repeat(129)])
        assert.throws(() => createMongoAvatarStorage({ connection: f.connection, prefix: bad }), { code: 'AVATAR_INVALID_PREFIX' });
    for (const bad of ['', id.toUpperCase(), '../' + id, id + '/x', '%2f', { $ne: '' }])
        await assert.rejects(f.store.saveAvatar(webp, { userId: bad, version: 1 }, f.persist));
    for (const bad of [0, -1, 1.2, '01', '1/2', '1\\2', '1e3', Number.MAX_SAFE_INTEGER + 1, {}, Infinity])
        await assert.rejects(f.store.saveAvatar(webp, { userId: id, version: bad }, f.persist));
    for (const bad of [`avatars/${id}/../avatar-1.webp`, `avatars/${id}/avatar-1.webp/extra`,
        `avatars/${id}/avatar-01.webp`, `avatars/${id}/avatar-1.webp?x`, `avatars/${id}/avatar-%31.webp`,
        `avatars/${id}%2f/avatar-1.webp`, `avatars/${id}\\avatar-1.webp`, { $ne: '' }]) {
        await assert.rejects(f.store.readAvatar(bad));
        await assert.rejects(f.store.deleteAvatar(bad));
    }
    assert.equal(f.state.calls.length, 0);
});

test('storage accepts only bounded static WebP pixels, never arbitrary or oversized payloads', async () => {
    const f = fixture();
    const png = await sharp(webp).png().toBuffer();
    const largePixels = await sharp({ create: { width: 513, height: 1, channels: 3, background: 'red' } }).webp().toBuffer();
    for (const buffer of [Buffer.alloc(0), Buffer.from('not an image'), png, Buffer.alloc(MAX_AVATAR_BYTES + 1),
        webp.subarray(0, webp.length - 1), largePixels])
        await assert.rejects(f.store.saveAvatar(buffer, { userId: id, version: 1 }, f.persist));
    assert.equal(f.state.transactions, 0); assert.equal(f.state.images.size, 0);
});

test('only the live referenced avatar is readable; deleted/closing users and mid-read closure are hidden', async () => {
    const f = fixture(), saved = await save(f);
    assert.equal(await f.store.readAvatar(f.store.keyFor(other, 1)), null);
    f.state.users.get(id).avatarKey = f.store.keyFor(id, 2);
    assert.equal(await f.store.readAvatar(saved.key), null);
    f.state.users.get(id).avatarKey = saved.key;
    f.onImageRead(() => { f.state.users.get(id).accountClosure = { requestedAt: new Date() }; });
    assert.equal(await f.store.readAvatar(saved.key), null);
    await assert.rejects(save(f, 2), { code: 'AVATAR_ACCOUNT_UNAVAILABLE' });
    f.state.users.delete(id);
    assert.equal(await f.store.readAvatar(saved.key), null);
});

test('bounded reads reject corrupt lengths and payloads and fail closed on disconnection', async () => {
    const f = fixture(), saved = await save(f);
    const row = f.state.images.get(id);
    for (const corrupt of [{ byteLength: MAX_AVATAR_BYTES + 1 }, { byteLength: webp.length - 1 },
        { data: Buffer.alloc(MAX_AVATAR_BYTES + 1) }, { data: 'not binary' }, { data: Buffer.alloc(webp.length) }]) {
        f.state.images.set(id, { ...row, ...corrupt });
        assert.equal(await f.store.readAvatar(saved.key), null);
    }
    const call = f.state.calls.find(c => c.name === MONGO_AVATAR_COLLECTION && c.op === 'findOne');
    assert.deepEqual(call.filter.$expr, { $eq: [{ $cond: [{ $eq: [{ $type: '$data' }, 'binData'] }, { $binarySize: '$data' }, 0] }, '$byteLength'] });
    f.connection.readyState = 0;
    await assert.rejects(f.store.readAvatar(saved.key), { code: 'AVATAR_UNAVAILABLE' });
});

test('strict account purge is idempotent, owner-scoped, and propagates database failures', async () => {
    const f = fixture(), saved = await save(f);
    f.state.images.set(other, { _id: other, key: f.store.keyFor(other, 1), data: webp, byteLength: webp.length });
    await assert.rejects(f.store.purgeUserAvatars('../' + id));
    await assert.rejects(f.store.purgeUserAvatars(id, f.store.keyFor(other, 1)), { code: 'DELETION_LEGACY_AVATAR_REVIEW' });
    assert.equal(f.state.images.size, 2);
    await f.store.purgeUserAvatars(id, f.store.keyFor(id, 99));
    await f.store.purgeUserAvatars(id, saved.key);
    assert.equal(f.state.images.size, 1); assert.ok(f.state.images.has(other));
    f.connection.readyState = 0;
    await assert.rejects(f.store.purgeUserAvatars(id), { code: 'AVATAR_UNAVAILABLE' });
});

test('account deletion transaction always purges Mongo images even after a driver switch', async () => {
    const calls = [], session = { synthetic: true };
    const connection = { collection: name => ({
        find: () => ({ toArray: async () => [] }),
        updateMany: async () => {},
        deleteMany: async (filter, options) => { calls.push({ name, filter, options }); },
    }) };
    await createDeletionCleanup(connection).erase({ _id: id }, session);
    assert.deepEqual(calls.find(c => c.name === MONGO_AVATAR_COLLECTION), {
        name: MONGO_AVATAR_COLLECTION, filter: { _id: id }, options: { session },
    });
    connection.collection = name => ({ find: () => ({ toArray: async () => [] }),
        deleteMany: async () => { assert.equal(name, MONGO_AVATAR_COLLECTION); throw new Error('synthetic purge failure'); } });
    await assert.rejects(createDeletionCleanup(connection).erase({ _id: id }, session), /synthetic purge failure/);
});

// Exercise Express routing without opening even a loopback socket.
function request(router, path, { method = 'GET', etag } = {}) {
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, headers: {},
            set(name, value) { for (const [k, v] of typeof name === 'object' ? Object.entries(name) : [[name, value]]) this.headers[k.toLowerCase()] = v; return this; },
            status(code) { this.statusCode = code; return this; },
            end(body) { this.body = body; resolve(this); return this; },
            send(body) { return this.end(body); },
        };
        router.handle({ method, url: path, get: name => name.toLowerCase() === 'if-none-match' ? etag : undefined }, res,
            error => reject(error || new Error('unexpected fallthrough')));
    });
}

test('Mongo GET/HEAD serve WebP length, privacy headers and stable ETags; conditional GET revalidates the owner', async () => {
    const f = fixture(), saved = await save(f), router = createMongoAvatarRouter({ storage: f.store });
    const path = '/' + saved.key, etag = `"${createHash('sha256').update(webp).digest('hex')}"`;
    const response = await request(router, path);
    assert.equal(response.statusCode, 200); assert.deepEqual(response.body, webp);
    assert.equal(response.headers['content-type'], 'image/webp');
    assert.equal(response.headers['content-length'], String(webp.length));
    assert.equal(response.headers['cache-control'], 'private, no-store, max-age=0');
    assert.equal(response.headers['cdn-cache-control'], 'no-store');
    assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(response.headers.etag, etag);
    for (const tag of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
        const cached = await request(router, path, { etag: tag });
        assert.equal(cached.statusCode, 304); assert.equal(cached.body, undefined);
    }
    assert.equal((await request(router, path, { etag: '"different"' })).statusCode, 200);
    const head = await request(router, path, { method: 'HEAD' });
    assert.equal(head.statusCode, 200); assert.equal(head.body, undefined);
    assert.equal(head.headers['content-length'], String(webp.length));
    await save(f, 2);
    assert.equal((await request(router, path, { etag })).statusCode, 404);
    f.state.users.get(id).accountClosure = { requestedAt: new Date() };
    assert.equal((await request(router, '/' + f.store.keyFor(id, 2), { etag })).statusCode, 404);
});

test('Mongo router rejects malformed paths with terminal no-store misses and never leaks errors', async () => {
    const f = fixture(), saved = await save(f), router = createMongoAvatarRouter({ storage: f.store });
    for (const path of [`/avatars/${id}/avatar-01.webp`, `/avatars/${id}%2fother/avatar-1.webp`,
        `/avatars/${id}/%2e%2e`, `/avatars/${id}/avatar-1.webp/extra`, '/other-local-file.webp',
        `/avatars/${id}/%ZZ`, `/avatars/${id}/avatar-1.png`]) {
        const res = await request(router, path);
        assert.equal(res.statusCode, 404); assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
    }
    f.connection.readyState = 0;
    const res = await request(router, '/' + saved.key);
    assert.equal(res.statusCode, 503); assert.equal(res.body, undefined);
});
