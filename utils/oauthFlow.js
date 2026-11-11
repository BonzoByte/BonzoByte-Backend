import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL = 10 * 60 * 1000;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const safeUrl = value => {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))))
        throw new Error('OAuth requires an HTTPS or loopback URL without credentials, query or fragment.');
    return url;
};

/** Browser-bound, signed, short-lived state. No server session, identity or provider token is stored. */
export function createOAuthFlow({ passport, provider, frontendUrl, callbackUrl, secret, issueToken, warn = message => console.warn(message), now = Date.now }) {
    if (!['google', 'facebook'].includes(provider)) throw new Error('Unsupported OAuth provider.');
    const frontend = safeUrl(frontendUrl), callback = safeUrl(callbackUrl);
    const secure = callback.protocol === 'https:';
    const cookieName = `${secure ? '__Host-' : ''}bb_oauth_${provider}`;
    const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
    const key = () => { const value = secret(); if (typeof value !== 'string' || value.length < 16) throw new Error('OAuth state secret unavailable.'); return value; };
    const sign = value => createHmac('sha256', key()).update(`bonzobyte-oauth-v1:${provider}:${callback.href}:${value}`).digest('base64url');
    const headers = res => res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    const failure = (res, code = 'oauth_failed') => {
        const target = new URL('/oauth-success', frontend.origin); target.searchParams.set('error', code);
        headers(res); return res.redirect(303, target.href);
    };
    const diagnostic = stage => warn(`[OAUTH] provider=${provider} stage=${stage} code=OAUTH_FAILED`);
    const cookie = req => {
        const pairs = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
        if (pairs.length !== 1) return null;
        try { return decodeURIComponent(pairs[0].slice(cookieName.length + 1)); } catch { return null; }
    };
    const validState = req => {
        const value = req.query.state;
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}\.[a-z0-9]{1,12}\.[A-Za-z0-9_-]{43}$/.test(value) || !same(value, cookie(req))) return false;
        const [nonce, until, signature] = value.split('.'), expires = parseInt(until, 36);
        return Number.isSafeInteger(expires) && expires > now() && expires <= now() + TTL && same(signature, sign(`${nonce}.${until}`));
    };
    return {
        start(req, res, next) {
            headers(res);
            try {
                const body = `${randomBytes(32).toString('base64url')}.${(now() + TTL).toString(36)}`, state = `${body}.${sign(body)}`;
                res.cookie(cookieName, state, { ...cookieOptions, maxAge: TTL });
                passport.authenticate(provider, { session: false, callbackURL: callback.href,
                    scope: provider === 'google' ? ['profile', 'email'] : ['email', 'public_profile'], state })(req, res, error => {
                        if (error && !res.headersSent) { diagnostic('start'); failure(res); } else if (!error) next();
                    });
            } catch { diagnostic('start'); if (!res.headersSent) failure(res); }
        },
        callback(req, res, next) {
            headers(res);
            try {
                if (!validState(req)) return failure(res);
                res.clearCookie(cookieName, cookieOptions);
                if (req.query.error === 'access_denied') return failure(res, 'oauth_cancelled');
                return passport.authenticate(provider, { session: false, callbackURL: callback.href }, (error, user, info) => {
                    if (res.headersSent) return;
                    if (error) { diagnostic('provider'); return failure(res); }
                    if (!user) return failure(res, info?.code === 'ACCOUNT_ERASURE_PENDING' ? 'account_erasure_pending' : 'oauth_failed');
                    try {
                        const token = issueToken(user._id, user.tokenVersion);
                        if (typeof token !== 'string' || !token) throw new Error('No access token.');
                        const target = new URL('/oauth-success', frontend.origin); target.hash = new URLSearchParams({ token }).toString();
                        return res.redirect(303, target.href);
                    } catch { diagnostic('token'); return failure(res); }
                })(req, res, error => { if (error && !res.headersSent) { diagnostic('callback'); failure(res); } else if (!error) next(); });
            } catch { diagnostic('callback'); if (!res.headersSent) failure(res); }
        },
    };
}

export const isAuthRequest = req => /^\/api\/auth(?:\/|$)/.test(String(req.originalUrl || req.url || '').split('?')[0]);
/** Route templates only: authorization codes, tokens, email parameters and request bodies never enter auth access logs. */
export function authAccessLog(tokens, req, res) {
    const route = typeof req.route?.path === 'string' ? `/api/auth${req.route.path}` : '/api/auth/[unmatched]';
    return `${tokens.method(req, res)} ${route} ${tokens.status(req, res)} ${tokens['response-time'](req, res)} ms`;
}
