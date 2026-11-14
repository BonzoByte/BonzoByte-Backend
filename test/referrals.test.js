import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEmail, canClaimInvitation, isReferralQualified, referralRewardPipeline, referralLink,
    invitationMail, tokenHash, validReferralToken, referralQuota, referralInvitationsUsedExpression } from '../utils/referralPolicy.js';
import { createReferralService } from '../utils/referralService.js';

const now = new Date('2026-09-29T12:00:00Z');
const sender = { _id: 'sender', isVerified: true, email: 'host@example.com', name: '<script>bad</script>',
    trial: { endsAt: new Date('2026-10-01T12:00:00Z'), grantedDaysTotal: 7 }, referral: {} };
const friend = { _id: 'friend', email: 'friend@example.com', isVerified: true, createdAt: now,
    referral: { referredBy: 'sender', activitySections: ['players', 'matches', 'tournaments'],
        firstActivityAt: new Date(now.getTime() - 120000), rewardedAt: null } };
const invitation = { _id: 'invite', sender: 'sender', recipientEmail: friend.email, delivery: 'sent',
    createdAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() + 86400000) };

test('claim is bound to recipient, new account, expiry, sender and once-only attribution', () => {
    const fresh = { ...friend, referral: {} };
    assert.equal(canClaimInvitation(invitation, fresh, sender, now), true);
    for (const changed of [
        { ...fresh, email: 'wrong@example.com' }, { ...fresh, _id: sender._id },
        { ...fresh, createdAt: new Date(now.getTime() - 2000) }, friend,
    ]) assert.equal(canClaimInvitation(invitation, changed, sender, now), false);
    assert.equal(canClaimInvitation({ ...invitation, expiresAt: now }, fresh, sender, now), false);
    assert.equal(canClaimInvitation({ ...invitation, delivery: 'failed' }, fresh, sender, now), false);
    assert.equal(canClaimInvitation(invitation, fresh, { ...sender, isVerified: false }, now), false);
    assert.equal(canonicalEmail('F.IrSt+alias@googlemail.com'), 'first@gmail.com');
});
test('qualification needs verified auth, three distinct sections and server elapsed time', () => {
    assert.equal(isReferralQualified(friend, now), true);
    for (const changed of [
        { ...friend, isVerified: false },
        { ...friend, referral: { ...friend.referral, activitySections: ['players', 'players', 'players'] } },
        { ...friend, referral: { ...friend.referral, activitySections: ['x', 'y', 'z'] } },
        { ...friend, referral: { ...friend.referral, firstActivityAt: new Date(now - 119999) } },
        { ...friend, referral: { ...friend.referral, rewardedAt: now } },
    ]) assert.equal(isReferralQualified(changed, now), false);
});
test('invitation token stays out of query/access logs and HTML is escaped', () => {
    const token = 'a'.repeat(64);
    const link = referralLink('http://localhost:4200', token);
    assert.equal(new URL(link).pathname, '/register');
    assert.equal(new URL(link).search, '');
    assert.equal(new URL(link).hash, '#ref=' + token);
    assert.equal(validReferralToken(token), true);
    assert.equal(validReferralToken('../bad'), false);
    assert.notEqual(tokenHash(token), token);
    const mail = invitationMail({ to: friend.email, senderName: sender.name, link, from: 'app@example.com' });
    assert.ok(!mail.html.includes('<script>'));
    assert.ok(mail.text.includes('7 extra trial days'));
});

// Evaluate just the Mongo expressions used in our atomic update; no live database/mail is touched.
const get = (object, path) => path.split('.').reduce((v, k) => v?.[k], object);
const set = (object, path, value) => { const keys = path.split('.'); const key = keys.pop(); let o = object;
    for (const k of keys) o = o[k] ??= {}; o[key] = value; };
function expr(value, document) {
    if (typeof value === 'string' && value.startsWith('$')) return get(document, value.slice(1));
    if (value instanceof Date) return value;
    if (Array.isArray(value)) return value.map(v => expr(v, document));
    if (!value || typeof value !== 'object') return value;
    if (!Object.keys(value)[0]?.startsWith('$')) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expr(v, document)]));
    const [op, args] = Object.entries(value)[0]; const a = expr(args, document);
    if (op === '$ifNull') return a[0] ?? a[1];
    if (op === '$max') return a.reduce((x, y) => x > y ? x : y);
    if (op === '$lt') return a[0] < a[1];
    if (op === '$eq') return a[0] === a[1];
    if (op === '$and') return a.every(Boolean);
    if (op === '$or') return a.some(Boolean);
    if (op === '$cond') return a[0] ? a[1] : a[2];
    if (op === '$concatArrays') return a.flat();
    if (op === '$mergeObjects') return Object.assign({}, ...a);
    if (op === '$setUnion') return [...new Set(a.flat())];
    if (op === '$add') return a[0] instanceof Date ? new Date(a[0].getTime() + a[1]) : a[0] + a[1];
    throw new Error('Unexpected expression: ' + op);
}
function apply(document, pipeline) {
    const values = Object.fromEntries(Object.entries(pipeline[0].$set).map(([k, v]) => [k, expr(v, document)]));
    for (const [k, v] of Object.entries(values)) set(document, k, v);
}
test('atomic reward preserves future days and starts expired/missing trials from now', () => {
    for (const end of [undefined, new Date(now - 86400000), new Date(now.getTime() + 2 * 86400000)]) {
        const doc = { trial: { endsAt: end }, referral: {} };
        apply(doc, referralRewardPipeline('friend', now));
        assert.equal(doc.trial.endsAt.getTime(), Math.max(end?.getTime() || 0, now.getTime()) + 7 * 86400000);
        assert.deepEqual(doc.referral.rewardedUserIds, ['friend']);
        assert.equal(doc.trial.grantedDaysTotal, 7);
    }
});
test('concurrent/replayed activities credit once, including recovery after final marker write fails', async () => {
    const owner = structuredClone(sender); const visitor = structuredClone(friend);
    let failMarker = true;
    const User = {
        async findOneAndUpdate() { return structuredClone(visitor); },
        async updateOne(filter, update) {
            if (filter._id === owner._id) {
                assert.equal(filter.isVerified, true);
                const id = filter['referral.rewardedUserIds'].$ne;
                if (owner.referral.rewardedUserIds?.includes(id)) return { matchedCount: 0 };
                apply(owner, update); return { matchedCount: 1 };
            }
            if (failMarker) { failMarker = false; throw new Error('simulated disconnect'); }
            visitor.referral.rewardedAt = update.$set['referral.rewardedAt']; return { matchedCount: 1 };
        },
        async exists(filter) { return owner.referral.rewardedUserIds?.includes(filter['referral.rewardedUserIds']); },
    };
    const api = createReferralService({ User, config: { enabled: true }, now: () => now });
    const results = await Promise.allSettled([api.activity(friend, 'players'), api.activity(friend, 'players')]);
    assert.ok(results.some(r => r.status === 'fulfilled'));
    await api.activity(friend, 'players');
    assert.equal(owner.referral.count, 1);
    assert.equal(owner.trial.endsAt.toISOString(), '2026-10-08T12:00:00.000Z');
    assert.ok(visitor.referral.rewardedAt);
});
test('invites enforce verified sender, explicit consent, self checks, mail config and durable quota', async () => {
    let sent = 0; let remaining = 1; let record;
    const User = { updateOne: async () => ({ matchedCount: remaining-- > 0 ? 1 : 0 }), exists: async () => false };
    const Invitation = { deleteOne: async () => {}, create: async data => (record = { ...data, _id: 'invite' }),
        updateOne: async (_filter, data) => Object.assign(record, data.$set) };
    const config = { enabled: true, mailEnabled: true, frontend: 'http://localhost:4200', from: 'app@example.com' };
    const api = createReferralService({ User, Invitation, config, now: () => now, sendMail: async () => { sent++; return { rejected: [] }; } });
    await assert.rejects(api.invite({ ...sender, isVerified: false }, friend.email, true), { code: 'VERIFICATION_REQUIRED' });
    await assert.rejects(api.invite(sender, sender.email, true), { code: 'SELF_REFERRAL' });
    await assert.rejects(api.invite(sender, friend.email, false), { code: 'INVALID_INVITATION' });
    assert.deepEqual(await api.invite(sender, friend.email, true), { accepted: true, delivery: 'sent', recipientEmail: friend.email });
    assert.equal(sent, 1); assert.equal(record.delivery, 'sent'); assert.equal(record.tokenHash.length, 64);
    await assert.rejects(api.invite(sender, 'next@example.com', true), { code: 'INVITATION_LIMIT' });
    config.mailEnabled = false;
    await assert.rejects(api.invite(sender, friend.email, true), { code: 'REFERRAL_MAIL_UNAVAILABLE' });
    assert.equal(sent, 1);
});
test('failed delivery cannot activate a referral and feature switch fails closed', async () => {
    let status;
    const config = { enabled: true, mailEnabled: true, frontend: 'http://localhost:4200' };
    const api = createReferralService({ config, User: { updateOne: async () => ({ matchedCount: 1 }), exists: async () => false },
        Invitation: { deleteOne: async () => {}, create: async () => ({ _id: 'invite' }),
            updateOne: async (_f, u) => { status = u.$set.delivery; } },
        sendMail: async () => { throw new Error('smtp unavailable'); } });
    await assert.rejects(api.invite(sender, friend.email, true), { code: 'REFERRAL_MAIL_UNAVAILABLE' });
    assert.equal(status, 'failed');
    config.enabled = false;
    await assert.rejects(api.activity(friend, 'players'), { code: 'REFERRALS_DISABLED' });
});

test('lifetime balance preserves known legacy usage and explicitly returns zero, never negative', () => {
    for (const [referral, remaining] of [
        [{}, 2], [{ invitationsUsed: 1 }, 1], [{ invitationsUsed: 2 }, 0],
        [{ invitationsUsed: 8 }, 0], [{ invitationsUsed: 0, emailWindowCount: 1 }, 1],
        [{ emailWindowCount: 5, emailWindowAt: new Date(0) }, 0], [{ count: 2 }, 0],
    ]) {
        const doc = { referral };
        assert.deepEqual(referralQuota(doc), { invitationLimit: 2, remainingInvitations: remaining });
        assert.equal(Math.max(0, 2 - expr(referralInvitationsUsedExpression, doc)), remaining);
    }
});

function budgetHarness({ existing = false, duplicate = false, fail = false, referral = {} } = {}) {
    const owner = { ...structuredClone(sender), referral };
    let time = now; let mailCount = 0;
    const User = {
        async updateOne(filter, pipeline) {
            assert.equal(filter._id, owner._id); assert.equal(filter.isVerified, true);
            if (!expr(filter.$expr, owner)) return { matchedCount: 0 };
            apply(owner, pipeline); return { matchedCount: 1 };
        },
        async exists() { return existing; },
    };
    const Invitation = {
        async deleteOne() {}, async updateOne() {},
        async create(data) {
            if (duplicate) throw Object.assign(new Error('duplicate'), { code: 11000 });
            return { ...data, _id: 'invite' };
        },
    };
    const config = { enabled: true, mailEnabled: true, frontend: 'http://localhost:4200' };
    const api = createReferralService({ User, Invitation, config, now: () => time,
        sendMail: async mail => {
            mailCount++;
            assert.ok(mail.text.includes('http://localhost:4200/register#ref='));
            if (fail) throw new Error('uncertain delivery');
            return { rejected: [] };
        } });
    return { api, owner, User, Invitation, config, mailCount: () => mailCount, setTime: value => { time = value; } };
}

test('three simultaneous requests send at most two emails; restarts and elapsed days do not refill', async () => {
    const h = budgetHarness();
    const results = await Promise.allSettled(['one', 'two', 'three'].map(name => h.api.invite(sender, name + '@example.com', true)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INVITATION_LIMIT');
    assert.equal(h.mailCount(), 2);
    assert.deepEqual(referralQuota(h.owner), { invitationLimit: 2, remainingInvitations: 0 });
    const later = new Date(now.getTime() + 60 * 86400000);
    h.setTime(later); // also beyond the invitation TTL
    await assert.rejects(h.api.invite(sender, friend.email, true), { code: 'INVITATION_LIMIT' });
    const restarted = createReferralService({ User: h.User, Invitation: h.Invitation, config: h.config, now: () => later,
        sendMail: () => assert.fail('exhausted account must not send') });
    await assert.rejects(restarted.invite(sender, friend.email, true), { code: 'INVITATION_LIMIT' });
});

test('invalid requests do not consume invitations; accepted duplicates, existing accounts and failures do', async () => {
    for (const options of [{ existing: true }, { duplicate: true }, { fail: true }]) {
        const h = budgetHarness(options);
        for (const [email, consent] of [[sender.email, true], ['bad', true], [friend.email, false]])
            await assert.rejects(h.api.invite(sender, email, consent));
        assert.equal(referralQuota(h.owner).remainingInvitations, 2);
        for (let i = 0; i < 2; i++) {
            if (options.fail) await assert.rejects(h.api.invite(sender, friend.email, true), { code: 'REFERRAL_MAIL_UNAVAILABLE' });
            else if (options.existing) await assert.rejects(h.api.invite(sender, friend.email, true), { code: 'RECIPIENT_ALREADY_REGISTERED', status: 409 });
            else assert.deepEqual(await h.api.invite(sender, friend.email, true), { accepted: true, delivery: 'duplicate', recipientEmail: friend.email });
            assert.equal(referralQuota(h.owner).remainingInvitations, 1 - i);
        }
        await assert.rejects(h.api.invite(sender, friend.email, true), { code: 'INVITATION_LIMIT' });
        assert.equal(h.mailCount(), options.fail ? 2 : 0);
    }
});
