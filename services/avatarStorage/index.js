import * as localAvatarStorage from './localAvatarStorage.js';

const driver = localAvatarStorage;

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
