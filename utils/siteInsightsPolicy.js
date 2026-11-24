import { createHmac } from 'node:crypto';

export const INSIGHTS_POLICY = 'site-insights-2026-11-20.1';
export const INSIGHTS_OWNERS = Object.freeze(['horvat.stanko@gmail.com', 'bonzobyte@gmail.com']);
export const INSIGHTS_SECTIONS = Object.freeze(['home', 'matches', 'players', 'tournaments', 'analytics', 'model-insights', 'simulation', 'popular', 'competition', 'tennis-break', 'fantasy', 'favourites', 'predictions']);
export const INSIGHTS_RETENTION_DAYS = 32;
export const INSIGHTS_COLLECTIONS = Object.freeze({ visits: 'siteinsights_visits', registrations: 'siteinsights_registrations', meta: 'siteinsights_meta' });
export const insightsError = (code, status = 400) => Object.assign(new Error(code), { code: 'SITE_INSIGHTS_' + code, status });
export const internalInsightsAccount = user => !!user?.testAccount || INSIGHTS_OWNERS.includes(String(user?.email || '').trim().toLowerCase());
export const insightsOwner = user => !!user && user.isVerified === true && !user.accountClosure?.requestedAt
    && INSIGHTS_OWNERS.includes(String(user.email || '').trim().toLowerCase());
export const insightsHash = (secret, purpose, value) => createHmac('sha256', secret).update(purpose + ':' + value).digest('hex');
export function insightsDay(at) {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
    const value = type => parts.find(p => p.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}
export function insightsFromDay(at, days) {
    const date = new Date(insightsDay(at) + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() - days + 1);
    return date.toISOString().slice(0, 10);
}
export const insightsUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function validateInsightsEvent(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['policy', 'consent', 'visitorId', 'eventId', 'section', 'excluded'].includes(k))
        || body.policy !== INSIGHTS_POLICY || body.consent !== true || !insightsUuid(body.visitorId) || !insightsUuid(body.eventId)
        || !INSIGHTS_SECTIONS.includes(body.section) || (body.excluded !== undefined && typeof body.excluded !== 'boolean')) throw insightsError('INVALID_EVENT');
    return body;
}
export function siteInsightsConfig(settings = process.env) {
    const enabled = settings.SITE_INSIGHTS_ENABLED === 'true';
    const origin = 'https://bonzobyte.com';
    const secret = String(settings.SITE_INSIGHTS_SECRET || '');
    if (enabled && (settings.NODE_ENV !== 'production' || settings.APP_STAGE !== 'beta' || settings.FRONTEND_URL !== origin
        || settings.BETA_PUBLIC_ORIGIN !== origin || settings.MONGO_DB !== 'BonzoByte_Beta' || secret.length < 32
        || secret === settings.JWT_SECRET || secret === settings.BETA_CODE_SECRET))
        throw insightsError('UNSAFE_CONFIGURATION', 503);
    const notifyTo = String(settings.SITE_INSIGHTS_NOTIFY_TO || '').trim().toLowerCase();
    const emailEnabled = enabled && settings.SITE_INSIGHTS_EMAIL_ENABLED === 'true';
    if (emailEnabled && !INSIGHTS_OWNERS.includes(notifyTo)) throw insightsError('INVALID_RECIPIENT', 503);
    // A copy is a single private mailbox, never an identity or a list of owners.
    let signupCopy = null;
    const to = String(settings.SITE_INSIGHTS_SIGNUP_COPY_TO || '').toLowerCase();
    const since = String(settings.SITE_INSIGHTS_SIGNUP_COPY_SINCE || '');
    if (emailEnabled && (to || since)) {
        const start = new Date(since);
        const mailbox = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
        if (to.length <= 254 && !/\s/.test(to) && mailbox.test(to) && Number.isFinite(+start)
            && (start.toISOString() === since || start.toISOString().replace('.000Z', 'Z') === since)) {
            if (to !== notifyTo) signupCopy = { to, start, tag: insightsHash(secret, 'signup-copy', start.toISOString() + ':' + to) };
        } else {
            console.warn('[SITE INSIGHTS] Invalid signup copy settings; owner delivery is unchanged.');
        }
    }
    return { enabled, origin, secret, emailEnabled, notifyTo, signupCopy, timeZone: 'Europe/Zagreb' };
}
export function summarizeInsights(rows, registrations, accounts, meta, at, days) {
    const visitors = new Set(), members = new Set(), daily = new Map(), sections = {};
    let views = 0;
    for (const row of rows) {
        visitors.add(row.visitorHash); for (const member of row.members || []) members.add(member);
        views += row.views || 0;
        const item = daily.get(row.day) || { day: row.day, views: 0, browsers: new Set(), confirmed: 0 };
        item.views += row.views || 0; item.browsers.add(row.visitorHash); daily.set(row.day, item);
        for (const [name, count] of Object.entries(row.sections || {})) if (INSIGHTS_SECTIONS.includes(name)) sections[name] = (sections[name] || 0) + count;
    }
    for (const row of registrations) {
        const item = daily.get(row.day) || { day: row.day, views: 0, browsers: new Set(), confirmed: 0 };
        item.confirmed++; daily.set(row.day, item);
    }
    return { generatedAt: at.toISOString(), startedAt: meta.startedAt, timeZone: 'Europe/Zagreb', days,
        views, browsers: visitors.size, activeMembers: members.size, confirmed: registrations.length, accounts,
        daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)).map(r => ({ day: r.day, views: r.views, browsers: r.browsers.size, confirmed: r.confirmed })),
        sections: Object.entries(sections).sort((a, b) => b[1] - a[1]).map(([section, views]) => ({ section, views })) };
}
