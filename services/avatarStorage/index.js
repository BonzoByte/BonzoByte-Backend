import { env } from '../../config/env.js';
import * as localAvatarStorage from './localAvatarStorage.js';
import * as r2AvatarStorage from './r2AvatarStorage.js';

function selectDriver() {
    switch (env.AVATAR_STORAGE_DRIVER) {
        case 'local':
            return localAvatarStorage;
        case 'r2':
            r2AvatarStorage.assertConfigured();
            return r2AvatarStorage;
        default:
            throw new Error(`Unsupported avatar storage driver: ${env.AVATAR_STORAGE_DRIVER}`);
    }
}

const driver = selectDriver();

export function getPublicUrl(key, options) {
    return driver.getPublicUrl(key, options);
}

export function saveAvatar(buffer, options) {
    return driver.saveAvatar(buffer, options);
}

export async function deleteAvatar(key) {
    try {
        await driver.deleteAvatar(key);
    } catch (err) {
        console.warn('[avatar-storage] Failed to delete old avatar:', err?.message || err);
    }
}
