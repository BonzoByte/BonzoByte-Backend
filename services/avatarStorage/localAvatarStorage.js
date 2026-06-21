import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env.js';
import { buildAvatarKey, joinPublicUrl } from './avatarStoragePaths.js';

const LOCAL_UPLOAD_ROOT = path.resolve('uploads');

function resolveStoragePath(key) {
    const normalizedKey = String(key || '').replace(/\\/g, '/');
    const resolved = path.resolve(LOCAL_UPLOAD_ROOT, normalizedKey);

    if (!resolved.startsWith(`${LOCAL_UPLOAD_ROOT}${path.sep}`)) {
        throw new Error('Invalid avatar key.');
    }

    return resolved;
}

export function getPublicUrl(key, { baseUrl } = {}) {
    return joinPublicUrl(baseUrl ? `${String(baseUrl).replace(/\/$/, '')}/uploads` : null, key);
}

export async function saveAvatar(buffer, { userId, version, baseUrl } = {}) {
    const key = buildAvatarKey({ userId, version, prefix: env.AVATAR_STORAGE_PREFIX });
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
