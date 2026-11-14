import test from 'node:test';
import assert from 'node:assert/strict';
import { deletionCodeHash, deletionMail, DELETION_REASONS } from '../utils/accountDeletion.js';
import { createDeletionCleanup } from '../utils/accountDeletionCleanup.js';
import { beginAccountOperation } from '../utils/accountOperation.js';
import { EventEmitter } from 'node:events';
import { completeDeletionReview } from '../utils/accountDeletionReview.js';

test('deletion proof is purpose/account/challenge bound and mail never contains a one-click destructive link', () => {
    const base = deletionCodeHash('synthetic-secret', 'actor', 'challenge', '123456');
    assert.notEqual(base, deletionCodeHash('synthetic-secret', 'other', 'challenge', '123456'));
    assert.notEqual(base, deletionCodeHash('synthetic-secret', 'actor', 'replacement', '123456'));
    for (const hr of [false, true]) {
        const mail = deletionMail('actor@example.invalid', '123456', hr);
        assert.ok(mail.text.includes('123456')); assert.equal(/https?:\/\//.test(mail.text), false);
        assert.equal(mail.to, 'actor@example.invalid');
    }
    assert.ok(!DELETION_REASONS.includes('arbitrary free text'));
});
test('cleanup stops before deletion for unmanaged real billing, unknown environments and unsettled payments', async () => {
    const user = { _id: 'synthetic', subscription: { provider: 'paypal', subscriptionId: 'live-or-unknown' } };
    const noDb = createDeletionCleanup({ collection() { assert.fail('no DB needed'); } });
    await assert.rejects(noDb.check(user, new Date()), { code: 'DELETION_RETENTION_REVIEW' });
    for (const row of [{ environment: 'live' }, { environment: 'sandbox', status: 'pending' },
        { environment: 'sandbox', status: 'completed', refundStatus: 'PENDING' }]) {
        const cleanup = createDeletionCleanup({ collection: () => ({ findOne: async () => null, find: () => ({ toArray: async () => [row] }) }) });
        await assert.rejects(cleanup.check({ _id: 'synthetic' }, new Date()), {
            code: row.environment === 'live' ? 'DELETION_RETENTION_REVIEW' : 'DELETION_PAYMENT_REVIEW' });
    }
});

test('account write leases include code delivery, support legacy versions and leave confirmation unleased', async () => {
    const writes = [], User = { collection: { updateOne: async (...args) => { writes.push(args); return { matchedCount: 1 }; } } };
    for (const path of ['/update', '/me/deletion/code']) {
        const res = new EventEmitter();
        assert.equal(await beginAccountOperation(User, { method: 'POST', baseUrl: '/api/users', path }, res, 'synthetic', 0), true);
        const claim = writes.at(-1);
        assert.deepEqual(claim[0].$or, [{ tokenVersion: 0 }, { tokenVersion: null }]);
        assert.deepEqual(claim[0]['accountClosure.requestedAt'], { $exists: false });
        res.emit('finish'); assert.ok(writes.at(-1)[1].$pull.accountOperations.id);
    }
    const count = writes.length;
    await beginAccountOperation(User, { method: 'POST', baseUrl: '/api/users/me/deletion', path: '/confirm' }, {}, 'synthetic', 0);
    assert.equal(writes.length, count);
});

test('external completion cannot be asserted without all reviews and a locally erased case', async () => {
    const writes = [], id = '012345678901234567890123';
    const Job = { updateOne: async (...args) => { writes.push(args); return { matchedCount: 1 }; } };
    await assert.rejects(completeDeletionReview(Job, id, { providers: true, backups: false, billing: true }), { code: 'DELETION_REVIEW_INCOMPLETE' });
    assert.equal(writes.length, 0);
    await completeDeletionReview(Job, id, { providers: true, backups: true, billing: true });
    assert.deepEqual(writes[0][0], { _id: id, state: 'app_erased' });
    for (const key of ['user', 'email', 'googleId', 'facebookId', 'providerMessageIds']) assert.equal(writes[0][1].$unset[key], 1);
});
