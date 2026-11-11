// Only labels from the existing public daily-match projection. No detail rows,
// member data, odds, predictions, or client-supplied title can be persisted here.
export const DISCUSSION_TITLE_TIMEOUT_MS = 750;
export function safeDiscussionTitle(value) {
    return typeof value === 'string' && value.trim() && value.length <= 164
        && !/[<>@\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value) && value.isWellFormed() ? value.trim() : null;
}
export async function resolveDiscussionTitle(resolver, matchTPId, timeoutMS = DISCUSSION_TITLE_TIMEOUT_MS) {
    if (typeof resolver.resolve !== 'function') return null;
    const controller = new AbortController(); let timer;
    const deadline = new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.min(DISCUSSION_TITLE_TIMEOUT_MS, Math.max(1, timeoutMS)));
    });
    try {
        const title = Promise.resolve().then(() => resolver.resolve([matchTPId], { signal: controller.signal })).then(rows => {
            const row = rows?.get(matchTPId);
            if (row?.matchTPId !== matchTPId) return null;
            const names = [row.player1Name, row.player2Name];
            if (names.some(name => typeof name !== 'string' || !name.trim() || name.length > 80)) return null;
            return safeDiscussionTitle(`${names[0].trim()} vs ${names[1].trim()}`);
        }).catch(() => null);
        return await Promise.race([title, deadline]);
    } finally { clearTimeout(timer); controller.abort(); }
}
