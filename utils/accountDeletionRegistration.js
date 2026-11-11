// Re-registration and erasure at external providers are separate decisions.
// Only a dated, operator-reviewed release of an already locally erased account
// stops blocking a NEW identity. Queued, undated and future-dated cases still block.
export function registrationBlockingDeletion(identity, at = new Date()) {
    if (!(at instanceof Date) || !Number.isFinite(+at)) throw new Error('INVALID_REVIEW_DATE');
    const alternatives = ['email', 'googleId', 'facebookId'].filter(key =>
        typeof identity?.[key] === 'string' && identity[key].trim() && identity[key].length <= 512)
        .map(key => ({ [key]: identity[key] }));
    if (!alternatives.length) throw new Error('INVALID_ACCOUNT_IDENTITY');
    return { state: { $ne: 'complete' }, $or: alternatives, $nor: [{
        state: 'app_erased', appErasedAt: { $type: 'date', $lte: at },
        registrationReleasedAt: { $type: 'date', $lte: at },
    }] };
}
