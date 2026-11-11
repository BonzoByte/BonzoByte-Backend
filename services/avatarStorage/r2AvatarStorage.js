import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { buildAvatarKey, joinPublicUrl } from './avatarStoragePaths.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const CONTENT_TYPE = 'image/webp';

let client;

function getEndpoint() {
    return env.AVATAR_R2_ENDPOINT ||
        (env.AVATAR_R2_ACCOUNT_ID ? `https://${env.AVATAR_R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
}

export function assertConfigured() {
    const missing = [];

    if (!env.AVATAR_R2_BUCKET) missing.push('AVATAR_R2_BUCKET');
    if (!env.AVATAR_PUBLIC_BASE_URL) missing.push('AVATAR_PUBLIC_BASE_URL');
    if (!env.AVATAR_R2_ACCESS_KEY_ID) missing.push('AVATAR_R2_ACCESS_KEY_ID');
    if (!env.AVATAR_R2_SECRET_ACCESS_KEY) missing.push('AVATAR_R2_SECRET_ACCESS_KEY');
    if (!getEndpoint()) missing.push('AVATAR_R2_ENDPOINT or AVATAR_R2_ACCOUNT_ID');

    if (missing.length) {
        throw new Error(`R2 avatar storage is not configured, missing: ${missing.join(', ')}`);
    }
}

function getClient() {
    assertConfigured();

    if (!client) {
        client = new S3Client({
            region: 'auto',
            endpoint: getEndpoint(),
            forcePathStyle: true,
            credentials: {
                accessKeyId: env.AVATAR_R2_ACCESS_KEY_ID,
                secretAccessKey: env.AVATAR_R2_SECRET_ACCESS_KEY,
            },
        });
    }

    return client;
}

export function getPublicUrl(key) {
    assertConfigured();
    return joinPublicUrl(env.AVATAR_PUBLIC_BASE_URL, key);
}

export async function saveAvatar(buffer, { userId, version } = {}) {
    assertConfigured();

    const key = buildAvatarKey({ userId, version, prefix: env.AVATAR_STORAGE_PREFIX });

    await getClient().send(new PutObjectCommand({
        Bucket: env.AVATAR_R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: CONTENT_TYPE,
        CacheControl: CACHE_CONTROL,
    }));

    return {
        key,
        publicUrl: getPublicUrl(key),
    };
}

export async function deleteAvatar(key) {
    if (!key) return;
    assertConfigured();

    await getClient().send(new DeleteObjectCommand({
        Bucket: env.AVATAR_R2_BUCKET,
        Key: key,
    }));
}

export async function purgeUserAvatars(userId, currentKey) {
    if (!/^[a-f0-9]{24}$/.test(userId)) throw new Error('Invalid account avatar target');
    const sample = buildAvatarKey({ userId, version: 1, prefix: env.AVATAR_STORAGE_PREFIX });
    const prefix = sample.slice(0, sample.lastIndexOf('/') + 1);
    if (currentKey && (!currentKey.startsWith(prefix) || !/^avatar-\d+\.webp$/.test(currentKey.slice(prefix.length))))
        throw Object.assign(new Error('Legacy avatar requires review'), { code: 'DELETION_LEGACY_AVATAR_REVIEW' });
    let token;
    do {
        const page = await getClient().send(new ListObjectsV2Command({ Bucket: env.AVATAR_R2_BUCKET,
            Prefix: prefix, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(20000) });
        for (const object of page.Contents || []) {
            if (!object.Key?.startsWith(prefix) || !/^avatar-\d+\.webp$/.test(object.Key.slice(prefix.length)))
                throw new Error('Avatar objects require review');
            await getClient().send(new DeleteObjectCommand({ Bucket: env.AVATAR_R2_BUCKET, Key: object.Key }),
                { abortSignal: AbortSignal.timeout(20000) });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token) throw new Error('Incomplete avatar listing');
    } while (token);
}
