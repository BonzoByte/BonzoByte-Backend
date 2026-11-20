// Community-only moderation. Never changes account roles, billing or private-message rights.
const owners = new Set(['horvat.stanko@gmail.com', 'bonzobyte@gmail.com']);
export function communityModerator(user, settings = process.env) {
    return !!user && user.isVerified === true && !user.accountClosure?.requestedAt
        && (user.isAdmin === true || (settings.COMMUNITY_OWNER_MODERATION === 'true'
            && owners.has(String(user.email || '').trim().toLowerCase())));
}
