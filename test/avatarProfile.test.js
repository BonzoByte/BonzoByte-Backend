import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const noDotenv = fileURLToPath(new URL('../__avatar_tests_no_dotenv__', import.meta.url));
function run(source, driver = '') {
    assert.equal(existsSync(noDotenv), false, 'never load a real environment file in regression tests');
    return execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, DOTENV_CONFIG_PATH: noDotenv, NODE_ENV: 'test', APP_STAGE: 'development',
            MONGO_URI: 'mongodb://127.0.0.1:27017/bonzobyte_unit_tests', MONGO_DB: 'bonzobyte_unit_tests',
            JWT_SECRET: 'synthetic-only-no-real-account-secret', BILLING_LAB_ENABLED: '', ARCHIVES_ONLY: '',
            PAYPAL_LIVE_ENABLED: 'false', PAYPAL_SANDBOX_ENABLED: 'false', PAYPAL_MEMBERSHIP_ENABLED: 'false',
            BILLING_EMAIL_ENABLED: 'false', AVATAR_STORAGE_DRIVER: driver, AVATAR_STORAGE_PREFIX: 'avatars',
            AVATAR_PUBLIC_BASE_URL: 'https://r2.example.invalid', AVATAR_R2_BUCKET: 'synthetic-avatars',
            AVATAR_R2_ENDPOINT: 'https://storage.example.invalid', AVATAR_R2_ACCESS_KEY_ID: 'synthetic',
            AVATAR_R2_SECRET_ACCESS_KEY: 'synthetic', NOW_OVERRIDE_ISO: '', NOW_ISO: '' } });
}

test('storage selection remains local by default and preserves local/R2 public URL contracts without connections', () => {
    const source = `
        import assert from 'node:assert/strict';
        import mongoose from 'mongoose';
        mongoose.connect = () => assert.fail('no database connection');
        mongoose.createConnection = () => assert.fail('no new connection');
        globalThis.fetch = () => assert.fail('no network');
        const { env } = await import('./config/env.js');
        const { getPublicUrl, mongoAvatarStorage } = await import('./services/avatarStorage/index.js');
        const driver = process.env.AVATAR_STORAGE_DRIVER || 'local';
        assert.equal(env.AVATAR_STORAGE_DRIVER, driver);
        assert.equal(!!mongoAvatarStorage, driver === 'mongo');
        const key = 'avatars/0123456789abcdef01234567/avatar-1.webp';
        const base = driver === 'r2' ? 'https://r2.example.invalid' : 'https://backend.example.invalid/uploads';
        assert.equal(getPublicUrl(key, { baseUrl: 'https://backend.example.invalid' }), base + '/' + key);
        assert.equal(mongoose.connection.readyState, 0);
    `;
    for (const driver of ['', 'local', 'r2', 'mongo']) run(source, driver);
});

test('actual profile controller keeps local/Mongo processing, replacement, rollback and no-photo edits intact', () => {
    const source = `
        import assert from 'node:assert/strict';
        import { mock } from 'node:test';
        import fs from 'node:fs';
        import fsp from 'node:fs/promises';
        import path from 'node:path';
        import sharp from 'sharp';
        import mongoose from 'mongoose';
        import User from './models/user.model.js';
        import { mongoAvatarFixture, AVATAR_USER as id } from './test/helpers/mongoAvatarFixture.js';
        const f = mongoAvatarFixture(), local = new Map();
        const mongo = process.env.AVATAR_STORAGE_DRIVER === 'mongo';
        mock.method(mongoose, 'connect', () => assert.fail('no database connection'));
        mock.method(mongoose, 'createConnection', () => assert.fail('no new connection'));
        globalThis.fetch = () => assert.fail('no network');
        mock.method(fsp, 'mkdir', async () => {});
        mock.method(fsp, 'writeFile', async (target, bytes) => { local.set(path.basename(target), bytes); });
        mock.method(fsp, 'unlink', async target => { local.delete(path.basename(target)); });
        // Buffer inputs let sharp exercise real decoding without temporary files.
        mock.method(fs, 'unlinkSync', () => {});
        mock.method(console, 'error', () => {});
        const { updateUserProfile, getUserProfile } = await import('./controllers/user.controller.js');
        if (mongo) {
            Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
            mongoose.connection.db = f.connection.db;
            mongoose.connection.transaction = (...args) => f.connection.transaction(...args);
        }
        let clock = 1800000000000, failSave = false, saves = 0;
        mock.method(Date, 'now', () => ++clock);
        const user = { _id: id, id, name: 'Synthetic', nickname: 'Synthetic', email: 'synthetic@example.invalid',
            isVerified: true, async save(options) {
                saves++;
                if (failSave) throw new Error('synthetic validation failure');
                if (mongo && this.avatarKey && options) assert.ok(options.session.inMemory);
                f.state.users.set(id, { _id: id, avatarKey: this.avatarKey, avatarUrl: this.avatarUrl });
            } };
        mock.method(User, 'findById', () => {
            const query = Promise.resolve(user); query.populate = async () => user; return query;
        });
        const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
        const call = async (image, body = {}, handler = updateUserProfile) => {
            const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; } };
            await handler({ user: { id }, protocol: 'https', get: () => 'backend.example.invalid', body,
                ...(image ? { file: { path: image } } : {}) }, res);
            return res;
        };
        const first = await call(png, { nickname: 'Updated' });
        assert.equal(first.statusCode, 200); assert.equal(first.body.user.nickname, 'Updated');
        assert.match(first.body.user.avatarUrl, new RegExp('/uploads/avatars/' + id + '/avatar-[0-9]+\\.webp$'));
        const oldKey = user.avatarKey;
        const bytes = mongo ? f.state.images.get(id).data : [...local.values()][0];
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
        assert.equal((await call(png)).statusCode, 200);
        const current = { ...user }, currentKey = user.avatarKey;
        assert.notEqual(currentKey, oldKey);
        assert.equal(mongo ? f.state.images.size : local.size, 1);
        failSave = true;
        assert.equal((await call(png)).statusCode, 500);
        assert.equal(mongo ? f.state.images.get(id).key : [...local.keys()][0], mongo ? currentKey : path.basename(currentKey));
        assert.equal(f.state.users.get(id).avatarKey, currentKey);
        assert.equal(mongo ? f.state.images.size : local.size, 1);
        Object.assign(user, current); failSave = false;
        const beforeInvalid = saves;
        assert.equal((await call(Buffer.from('invalid image'))).statusCode, 400);
        assert.equal(saves, beforeInvalid);
        const transactions = f.state.transactions;
        assert.equal((await call(null, { name: 'Renamed' })).statusCode, 200);
        assert.equal(saves, beforeInvalid + 1); assert.equal(f.state.transactions, transactions);
        assert.equal((await call(null, {}, getUserProfile)).body.avatarUrl,
            'https://backend.example.invalid/uploads/' + currentKey);
        mock.restoreAll();
    `;
    for (const driver of ['local', 'mongo']) run(source, driver);
});
