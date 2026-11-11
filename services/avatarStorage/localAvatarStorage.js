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

export async function purgeUserAvatars(userId, currentKey) {
    if (!/^[a-f0-9]{24}$/.test(userId)) throw new Error('Invalid account avatar target');
    const sample = buildAvatarKey({ userId, version: 1, prefix: env.AVATAR_STORAGE_PREFIX });
    if (currentKey && (path.posix.dirname(currentKey) !== path.posix.dirname(sample) || !/^avatar-\d+\.webp$/.test(path.posix.basename(currentKey))))
        throw Object.assign(new Error('Legacy avatar requires review'), { code: 'DELETION_LEGACY_AVATAR_REVIEW' });
    const directory = path.dirname(resolveStoragePath(sample));
    let stat;
    try { stat = await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe avatar directory');
    const realRoot = await fs.realpath(LOCAL_UPLOAD_ROOT), realDirectory = await fs.realpath(directory);
    if (!realDirectory.startsWith(realRoot + path.sep) || path.basename(realDirectory) !== userId)
        throw new Error('Unsafe avatar directory');
    const names = await fs.readdir(realDirectory);
    if (names.some(name => !/^avatar-\d+\.webp$/.test(name))) throw new Error('Avatar directory requires review');
    for (const name of names) {
        const target = path.join(realDirectory, name);
        const file = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!file) continue;
        if (!file.isFile() || file.isSymbolicLink()) throw new Error('Unsafe avatar file');
        await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rmdir(realDirectory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
}
