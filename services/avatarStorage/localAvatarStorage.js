import fs from 'fs/promises';
import path from 'path';

const AVATAR_ROOT = path.resolve('uploads/avatars');
const AVATAR_PREFIX = 'avatars';

function buildKey(userId, version) {
    return `${AVATAR_PREFIX}/${String(userId)}/avatar-${String(version)}.webp`;
}

function publicPathForKey(key) {
    return key.split('/').map(encodeURIComponent).join('/');
}

function resolveStoragePath(key) {
    const normalizedKey = String(key || '').replace(/\\/g, '/');
    const relativeKey = normalizedKey.startsWith(`${AVATAR_PREFIX}/`)
        ? normalizedKey.slice(AVATAR_PREFIX.length + 1)
        : normalizedKey;
    const resolved = path.resolve(AVATAR_ROOT, relativeKey);

    if (!resolved.startsWith(`${AVATAR_ROOT}${path.sep}`)) {
        throw new Error('Invalid avatar key.');
    }

    return resolved;
}

export function getPublicUrl(key, { baseUrl } = {}) {
    if (!key || !baseUrl) return null;
    return `${String(baseUrl).replace(/\/$/, '')}/uploads/${publicPathForKey(key)}`;
}

export async function saveAvatar(buffer, { userId, version, baseUrl } = {}) {
    const key = buildKey(userId, version);
    const targetPath = resolveStoragePath(key);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, buffer);

    return {
        key,
        publicUrl: getPublicUrl(key, { baseUrl }),
    };
}

export async function deleteAvatar(key) {
    if (!key) return;

    try {
        await fs.unlink(resolveStoragePath(key));
    } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
    }
}
