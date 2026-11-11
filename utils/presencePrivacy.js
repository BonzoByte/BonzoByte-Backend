export const presencePrivacyDto = user => ({ showOnlineStatus: user?.presencePrivacy?.showOnlineStatus === true });
export function updatePresencePrivacy(user, value) {
    if (value === undefined) return;
    if (![true, false, 'true', 'false'].includes(value))
        throw Object.assign(new Error('Invalid online-status preference'), { code: 'PRESENCE_INVALID_PRIVACY', status: 400 });
    const enabled = value === true || value === 'true';
    if (enabled && user.isVerified !== true)
        throw Object.assign(new Error('Verification required'), { code: 'PRESENCE_VERIFICATION_REQUIRED', status: 403 });
    user.presencePrivacy = { showOnlineStatus: enabled };
}
