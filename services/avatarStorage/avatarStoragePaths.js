const DEFAULT_AVATAR_PREFIX = 'avatars';

export function normalizeAvatarPrefix(prefix = DEFAULT_AVATAR_PREFIX) {
    const cleaned = String(prefix || DEFAULT_AVATAR_PREFIX)
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
        .join('/');

    if (!cleaned || cleaned.split('/').some((part) => part === '.' || part === '..')) {
        throw new Error('Invalid avatar storage prefix.');
    }

    return cleaned;
}

function safePathSegment(value, name) {
    const segment = String(value || '').trim();
    if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) {
        throw new Error(`Invalid avatar ${name}.`);
    }
    return segment;
}

export function buildAvatarKey({ userId, version, prefix = DEFAULT_AVATAR_PREFIX } = {}) {
    const normalizedPrefix = normalizeAvatarPrefix(prefix);
    const safeUserId = safePathSegment(userId, 'user id');
    const safeVersion = safePathSegment(version, 'version');
    return `${normalizedPrefix}/${safeUserId}/avatar-${safeVersion}.webp`;
}

export function publicPathForKey(key) {
    return String(key || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
}

export function joinPublicUrl(baseUrl, key) {
    if (!baseUrl || !key) return null;
    return `${String(baseUrl).replace(/\/$/, '')}/${publicPathForKey(key)}`;
}
