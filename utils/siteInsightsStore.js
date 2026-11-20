import { randomUUID } from 'node:crypto';
import { INSIGHTS_COLLECTIONS as names, INSIGHTS_OWNERS, INSIGHTS_RETENTION_DAYS, insightsDay, insightsFromDay, insightsHash, insightsError, summarizeInsights } from './siteInsightsPolicy.js';

export function createSiteInsightsStore({ connection, User, config, now = () => new Date(), mailer }) {
    const c = key => connection.collection(names[key]);
    let metadata;
    async function initialize() {
        await User.collection.createIndex({ isVerified: 1, siteInsightsRegistrationObservedAt: 1, createdAt: 1 }, { name: 'site_insights_registration_scan' });
        await c('visits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await c('visits').createIndex({ day: 1 });
        await c('registrations').createIndex({ userId: 1 }, { unique: true, sparse: true });
        await c('registrations').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await c('registrations').createIndex({ day: 1 });
        await c('meta').updateOne({ _id: 'v1' }, { $setOnInsert: { startedAt: now(), policy: 'site-insights-2026-11-20.1' } }, { upsert: true });
        metadata = await c('meta').findOne({ _id: 'v1' });
    }
    async function record(event, user) {
        const at = now(), day = insightsDay(at), visitorHash = insightsHash(config.secret, 'visitor', event.visitorId);
        const id = day + ':' + visitorHash, eventHash = insightsHash(config.secret, 'event', event.eventId);
        try { await c('visits').updateOne({ _id: id }, { $setOnInsert: { day, visitorHash, views: 0, sections: {}, seen: [], members: [],
            expiresAt: new Date(+at + INSIGHTS_RETENTION_DAYS * 86400000) } }, { upsert: true }); }
        catch (error) { if (error.code !== 11000) throw error; }
        const member = user?.isVerified === true ? insightsHash(config.secret, 'member', String(user._id)) : null;
        await c('visits').updateOne({ _id: id, seen: { $ne: eventHash }, views: { $lt: 1000 } }, {
            $inc: { views: 1, ['sections.' + event.section]: 1 }, $set: { lastAt: at },
            $addToSet: { seen: eventHash, ...(member ? { members: member } : {}) },
        });
    }
    async function purge(visitorId) {
        await c('visits').deleteMany({ visitorHash: insightsHash(config.secret, 'visitor', visitorId) });
    }
    const external = { email: { $nin: INSIGHTS_OWNERS }, testAccount: { $exists: false }, 'accountClosure.requestedAt': { $exists: false } };
    async function observeRegistrations() {
        // Bounded persistent reconciliation handles password and OAuth verification,
        // restarts and retries without modifying registration/login response paths.
        const users = await User.collection.find({ ...external, isVerified: true, createdAt: { $gte: metadata.startedAt, $lte: now() },
            siteInsightsRegistrationObservedAt: { $exists: false } }, { projection: { _id: 1, provider: 1 }, maxTimeMS: 5000 })
            .sort({ createdAt: 1, _id: 1 }).limit(20).toArray();
        for (const user of users) {
            const at = now();
            try { await connection.transaction(async session => {
                const claimed = await User.collection.updateOne({ _id: user._id, ...external, isVerified: true,
                    siteInsightsRegistrationObservedAt: { $exists: false } }, { $set: { siteInsightsRegistrationObservedAt: at } }, { session });
                if (!claimed.modifiedCount) return;
                await c('registrations').updateOne({ userId: user._id }, { $setOnInsert: { userId: user._id, day: insightsDay(at), observedAt: at,
                    provider: user.provider?.includes('google') ? 'google' : 'email', read: false,
                    emailState: config.emailEnabled ? 'pending' : 'disabled', attempts: 0, nextAttemptAt: at,
                    expiresAt: new Date(+at + 90 * 86400000) } }, { upsert: true, session });
            }); }
            catch (error) { if (error.code !== 11000) throw error; }
        }
        return users.length;
    }
    async function sendRegistrationMail() {
        if (!config.emailEnabled || mailer?.provider !== 'resend' || !mailer?.isConfigured) return;
        const at = now(), lease = randomUUID();
        // Resend idempotency keys last 24h. Stop retrying after 20h rather than
        // risking duplicate mail after an ambiguous provider response.
        const row = await c('registrations').findOneAndUpdate({ userId: { $exists: true },
            emailState: { $in: ['pending', 'sending'] }, nextAttemptAt: { $lte: at }, attempts: { $lt: 5 },
            $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: at } }] },
        { $set: { emailState: 'sending', lease, leaseUntil: new Date(+at + 120000), nextAttemptAt: new Date(+at + 60000) }, $inc: { attempts: 1 } },
        { returnDocument: 'after', includeResultMetadata: false });
        if (!row) return;
        if (+at - +row.observedAt >= 20 * 3600000) {
            await c('registrations').updateOne({ _id: row._id, lease }, { $set: { emailState: 'review' }, $unset: { lease: '', leaseUntil: '' } }); return;
        }
        const user = await User.collection.findOne({ _id: row.userId, ...external, isVerified: true }, { projection: { _id: 1 } });
        if (!user) { await c('registrations').updateOne({ _id: row._id, lease }, { $set: { emailState: 'suppressed' }, $unset: { lease: '', leaseUntil: '' } }); return; }
        try {
            await mailer.sendMail({ channel: 'accounts', to: config.notifyTo, subject: 'BonzoByte — novi potvrđeni korisnik',
                text: `Novi vanjski korisnički račun potvrđen je na BonzoByteu.\nZabilježeno: ${row.observedAt.toISOString()}\nNačin registracije: ${row.provider}.\nPregled: https://bonzobyte.com/site-insights\nPoruka ne sadrži osobne podatke korisnika.` },
            { idempotencyKey: 'site-registration-' + row._id });
            await c('registrations').updateOne({ _id: row._id, lease }, { $set: { emailState: 'accepted' }, $unset: { lease: '', leaseUntil: '' } });
        } catch {
            await c('registrations').updateOne({ _id: row._id, lease }, { $set: { emailState: row.attempts >= 5 ? 'review' : 'pending' }, $unset: { lease: '', leaseUntil: '' } });
        }
    }
    async function summary(days) {
        const at = now(), from = insightsFromDay(at, days), until = insightsDay(at);
        const rows = await c('visits').find({ day: { $gte: from, $lte: until }, expiresAt: { $gt: at } },
            { projection: { visitorHash: 1, members: 1, views: 1, day: 1, sections: 1 }, maxTimeMS: 5000 }).limit(50001).toArray();
        const registrations = await c('registrations').find({ day: { $gte: from, $lte: until } },
            { projection: { day: 1 }, maxTimeMS: 5000 }).limit(50001).toArray();
        if (rows.length > 50000 || registrations.length > 50000) throw insightsError('SUMMARY_LIMIT', 503);
        const all = await User.collection.countDocuments({}, { maxTimeMS: 5000 });
        const internal = await User.collection.countDocuments({ $or: [{ email: { $in: INSIGHTS_OWNERS } }, { testAccount: { $exists: true } }] }, { maxTimeMS: 5000 });
        const confirmedExternal = await User.collection.countDocuments({ ...external, isVerified: true }, { maxTimeMS: 5000 });
        const externalTotal = await User.collection.countDocuments(external, { maxTimeMS: 5000 });
        return summarizeInsights(rows, registrations, { all, internal, external: externalTotal, confirmedExternal }, metadata, at, days);
    }
    async function notifications() {
        const rows = await c('registrations').find({}, { projection: { observedAt: 1, provider: 1, read: 1, emailState: 1 }, maxTimeMS: 5000 }).sort({ observedAt: -1 }).limit(50).toArray();
        return rows.map(r => ({ id: String(r._id), at: r.observedAt, provider: r.provider, read: r.read === true, emailState: r.emailState }));
    }
    async function markRead(ids) {
        const { ObjectId } = await import('mongodb');
        await c('registrations').updateMany({ _id: { $in: ids.map(id => new ObjectId(id)) } }, { $set: { read: true } });
    }
    return { initialize, record, purge, summary, notifications, markRead, observeRegistrations, sendRegistrationMail };
}
