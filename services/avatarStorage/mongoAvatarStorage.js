import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import sharp from 'sharp';
import { joinPublicUrl } from './avatarStoragePaths.js';

export const MONGO_AVATAR_COLLECTION = 'avatarimages';
export const MAX_AVATAR_BYTES = 256 * 1024;
const MAX_DIMENSION = 512;
const DB_TIMEOUT_MS = 5000;
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);

function validatePrefix(prefix) {
    if (typeof prefix !== 'string' || prefix.length > 128 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix))
        throw fail('AVATAR_INVALID_PREFIX');
    return prefix;
}
function validateVersion(version) {
    if (!['string', 'number'].includes(typeof version) || !/^[1-9]\d{0,15}$/.test(String(version))
        || !Number.isSafeInteger(Number(version))) throw fail('AVATAR_INVALID_VERSION');
    return String(version);
}
function isWebp(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= 20 && buffer.length <= MAX_AVATAR_BYTES
        && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP'
        && buffer.readUInt32LE(4) === buffer.length - 8;
}

// One bounded document per user (_id is the canonical user id). No version history,
// GridFS, extra credentials, TTL race, or process-local image cache is needed.
export function createMongoAvatarStorage({ connection, prefix = 'avatars' }) {
    validatePrefix(prefix);
    const collection = () => {
        if (connection.readyState !== 1 || !connection.db) throw fail('AVATAR_UNAVAILABLE', 503);
        return connection.db.collection(MONGO_AVATAR_COLLECTION);
    };
    const users = () => connection.db.collection('users');
    // The driver rejects per-operation timeoutMS inside a CSOT transaction.
    // The transaction below has its own bounded deadline for all its operations.
    const options = session => session ? { session } : { timeoutMS: DB_TIMEOUT_MS };
    function keyFor(userId, version) {
        if (!validId(userId)) throw fail('AVATAR_INVALID_USER');
        return `${prefix}/${userId}/avatar-${validateVersion(version)}.webp`;
    }
    function parseKey(key) {
        if (typeof key !== 'string' || !key.startsWith(prefix + '/')) throw fail('AVATAR_INVALID_KEY');
        const parts = key.slice(prefix.length + 1).split('/');
        const match = /^avatar-([1-9]\d{0,15})\.webp$/.exec(parts[1] || '');
        if (parts.length !== 2 || !match || keyFor(parts[0], match[1]) !== key) throw fail('AVATAR_INVALID_KEY');
        return { userId: parts[0] };
    }
    function getPublicUrl(key, { baseUrl } = {}) {
        if (!key) return null;
        parseKey(key);
        return joinPublicUrl(baseUrl ? `${String(baseUrl).replace(/\/$/, '')}/uploads` : null, key);
    }
    const ownerFilter = (userId, key) => ({ _id: new Types.ObjectId(userId),
        ...(key ? { avatarKey: key } : {}), 'accountClosure.requestedAt': { $exists: false } });
    async function saveAvatar(buffer, { userId, version, baseUrl } = {}, persistUser) {
        const key = keyFor(userId, version);
        if (!isWebp(buffer)) throw fail('AVATAR_INVALID_IMAGE');
        const metadata = await sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_DIMENSION ** 2 }).metadata();
        if (metadata.format !== 'webp' || !metadata.width || !metadata.height
            || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION || (metadata.pages || 1) !== 1)
            throw fail('AVATAR_INVALID_IMAGE');
        if (typeof persistUser !== 'function') throw fail('AVATAR_REFERENCE_REQUIRED');
        const images = collection();
        const saved = { key, publicUrl: getPublicUrl(key, { baseUrl }) };
        await connection.transaction(async session => {
            const active = await users().findOne(ownerFilter(userId), { ...options(session), projection: { _id: 1, avatarKey: 1 } });
            if (!active) throw fail('AVATAR_ACCOUNT_UNAVAILABLE', 404);
            if (active.avatarKey === key) throw fail('AVATAR_VERSION_CONFLICT', 409);
            await images.replaceOne({ _id: userId }, { _id: userId, key, data: buffer, byteLength: buffer.length },
                { ...options(session), upsert: true });
            await persistUser(saved, { session });
            // A callback that forgot to save the reference must never replace the old image.
            if (!await users().findOne(ownerFilter(userId, key), { ...options(session), projection: { _id: 1 } }))
                throw fail('AVATAR_REFERENCE_NOT_SAVED', 409);
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
            maxCommitTimeMS: DB_TIMEOUT_MS, timeoutMS: 10000 });
        return saved;
    }
    async function readAvatar(key) {
        const { userId } = parseKey(key), images = collection();
        const active = () => users().findOne(ownerFilter(userId, key), { ...options(), projection: { _id: 1 } });
        if (!await active()) return null;
        // Check actual BSON binary length on the server BEFORE transferring bytes.
        // Metadata alone cannot keep a corrupt/legacy document from allocating a large buffer.
        const row = await images.findOne({ _id: userId, key, byteLength: { $gte: 20, $lte: MAX_AVATAR_BYTES },
            $expr: { $eq: [{ $cond: [{ $eq: [{ $type: '$data' }, 'binData'] }, { $binarySize: '$data' }, 0] }, '$byteLength'] } },
        { ...options(), projection: { data: 1, byteLength: 1 }, promoteBuffers: true });
        const buffer = row?.data;
        if (!isWebp(buffer) || buffer.length !== row.byteLength || !await active()) return null;
        return { buffer, etag: `"${createHash('sha256').update(buffer).digest('hex')}"` };
    }
    async function deleteAvatar(key) {
        if (!key) return;
        const { userId } = parseKey(key);
        // An old-key cleanup must not remove its already-committed replacement.
        await collection().deleteOne({ _id: userId, key }, options());
    }
    async function purgeUserAvatars(userId, currentKey) {
        if (!validId(userId)) throw fail('AVATAR_INVALID_USER');
        if (currentKey) {
            try { if (parseKey(currentKey).userId !== userId) throw fail('AVATAR_INVALID_KEY'); }
            catch { throw fail('DELETION_LEGACY_AVATAR_REVIEW'); }
        }
        // Purge by owner, not just currentKey: idempotent even if the reference is stale.
        await collection().deleteMany({ _id: userId }, options());
    }
    return { keyFor, parseKey, getPublicUrl, saveAvatar, readAvatar, deleteAvatar, purgeUserAvatars };
}
