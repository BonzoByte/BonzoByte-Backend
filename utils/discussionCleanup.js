import { DISCUSSION_COLLECTIONS } from '../models/discussion.model.js';

// Called INSIDE accountDeletion's user-fenced transaction, never after commit.
export async function eraseDiscussions(connection, userId, session, names = DISCUSSION_COLLECTIONS) {
    const c = key => connection.collection(names[key]), options = { session };
    await c('comments').updateMany({ userId }, { $set: { body: '', deleted: true },
        $unset: { userId: '', clientRequestId: '', requestHash: '' } }, options);
    await c('reports').deleteMany({ $or: [{ userId }, { authorId: userId }] }, options);
    await c('states').deleteMany({ userId }, options);
    await c('spam').deleteMany({ _id: userId }, options);
    // Reply IDs and chronological sequence tombstones remain; no copied profiles,
    // author IDs, content hashes, or reporter identities remain for this account.
}
