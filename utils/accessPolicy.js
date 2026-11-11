export const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
export function emailAllowlist(value = '') {
    const entries = value.split(',').map(normalizeEmail).filter(Boolean);
    if (entries.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[*<>]/.test(email)))
        throw new Error('BETA_TESTERS must contain exact email addresses, not patterns.');
    return new Set(entries);
}
export function exactOrigins(value) {
    const entries = value.split(',').map(s => s.trim()).filter(Boolean);
    if (entries.some(entry => {
        try { const url = new URL(entry); return !['https:', 'http:'].includes(url.protocol) || url.origin !== entry || entry.includes('*'); }
        catch { return true; }
    })) throw new Error('CORS_ORIGINS must contain exact origins without paths or wildcards.');
    return entries;
}
export function createCorsOptions(origins) {
    return { origin(origin, callback) {
        const allowed = !origin || origins.includes(origin);
        callback(allowed ? null : new Error('Not allowed by CORS'), allowed);
    }, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    credentials: true, optionsSuccessStatus: 204 };
}
export const privateHeaders = { 'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' };
export function forcePrivateHeaders(_req, res, next) {
    const headers = Object.fromEntries(Object.entries(privateHeaders).map(([key, value]) => [key.toLowerCase(), value]));
    const original = res.setHeader.bind(res);
    res.setHeader = (name, value) => original(name, headers[name.toLowerCase()] ?? value);
    res.set(privateHeaders); next();
}
export function isBetaAccountAllowed(email, settings = process.env) {
    return settings.APP_STAGE !== 'beta' || emailAllowlist(settings.BETA_TESTERS).has(normalizeEmail(email));
}
export function privateAccessLog(tokens, req, res) {
    // Route templates only: never log query strings, emails in path parameters,
    // cookies, authorization headers or request bodies at the beta entrance/API.
    return `${tokens.method(req, res)} ${req.route?.path || '[unmatched]'} ${tokens.status(req, res)} ${tokens['response-time'](req, res)} ms`;
}
