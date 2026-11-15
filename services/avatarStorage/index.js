import { env } from '../../config/env.js';
import * as localAvatarStorage from './localAvatarStorage.js';
import * as r2AvatarStorage from './r2AvatarStorage.js';
import mongoose from 'mongoose';
import { createMongoAvatarStorage } from './mongoAvatarStorage.js';

// Opt-in only; reuse the application's connection, never open a second database.
export const mongoAvatarStorage = env.AVATAR_STORAGE_DRIVER === 'mongo'
    ? createMongoAvatarStorage({ connection: mongoose.connection, prefix: env.AVATAR_STORAGE_PREFIX }) : null;

function selectDriver() {
    switch (env.AVATAR_STORAGE_DRIVER) {
        case 'local':
            return localAvatarStorage;
        case 'r2':
            r2AvatarStorage.assertConfigured();
            return r2AvatarStorage;
        case 'mongo':
            return mongoAvatarStorage;
        default:
            throw new Error(`Unsupported avatar storage driver: ${env.AVATAR_STORAGE_DRIVER}`);
    }
}

const driver = selectDriver();

export function getPublicUrl(key, options) {
    return driver.getPublicUrl(key, options);
}

// The callback saves the user reference. Mongo runs both writes in one transaction;
// local/R2 keep their existing save-then-reference and best-effort rollback contract.
export async function saveAvatar(buffer, options, persistUser) {
    if (mongoAvatarStorage) return driver.saveAvatar(buffer, options, persistUser);
    const saved = await driver.saveAvatar(buffer, options);
    if (persistUser) await persistUser(saved);
    return saved;
}

// Unlike best-effort replacement cleanup, account erasure MUST observe errors.
export function purgeUserAvatars(userId, currentKey) { return driver.purgeUserAvatars(userId, currentKey); }

export async function deleteAvatar(key) {
    try {
        await driver.deleteAvatar(key);
    } catch (err) {
        console.warn('[avatar-storage] Failed to delete old avatar:', err?.message || err);
    }
}
