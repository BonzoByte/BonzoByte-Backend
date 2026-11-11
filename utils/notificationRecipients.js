import { Types } from 'mongoose';
import { DISCUSSION_COLLECTIONS } from '../models/discussion.model.js';
import { PRIVATE_MESSAGE_COLLECTIONS } from '../models/privateMessages.model.js';
const valid = id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
const read = projection => ({ projection, maxTimeMS: 2000, timeoutMS: 2500 });

/** Post-commit metadata reads only. Never fetch bodies, deliver comments or change read watermarks. */
export function createNotificationDelivery({ connection, hub }) {
    const collection = name => connection.collection(name), object = id => new Types.ObjectId(id);
    async function conversation(id) {
        if (!valid(id)) return [];
        const row = await collection(PRIVATE_MESSAGE_COLLECTIONS.pmConversations).findOne({ _id: object(id) }, read({ participants: 1 }));
        const ids = row?.participants?.map(String) ?? [];
        return ids.length === 2 && ids.every(valid) ? ids : [];
    }
    async function publicMatch(matchTPId) {
        const connected = hub.connectedUsers(); if (!connected.length || !Number.isSafeInteger(matchTPId) || matchTPId <= 0) return;
        const allowed = new Set(connected), rows = await collection(DISCUSSION_COLLECTIONS.states)
            .find({ userId: { $in: connected.map(object) }, matchTPId, following: true }, read({ _id: 0, userId: 1 })).limit(connected.length).toArray();
        hub.notify(rows.map(row => String(row.userId)).filter(id => allowed.has(id)), 'public');
    }
    async function deliver(event) {
        if (!hub.size() || !valid(event.actor)) return;
        if (event.kind === 'public-actor') return hub.notify([event.actor], 'public');
        if (event.kind === 'public-match') return publicMatch(event.matchTPId);
        if (event.kind === 'public-comment' && valid(event.id)) {
            const row = await collection(DISCUSSION_COLLECTIONS.comments).findOne({ _id: object(event.id) }, read({ matchTPId: 1 }));
            return publicMatch(row?.matchTPId);
        }
        if (event.kind === 'private-actor') return hub.notify([event.actor], 'private');
        if (event.kind === 'private-conversation') {
            const ids = await conversation(event.id); if (ids.includes(event.actor)) hub.notify(ids, 'private');
        } else if (event.kind === 'private-message' && valid(event.id)) {
            const row = await collection(PRIVATE_MESSAGE_COLLECTIONS.pmMessages).findOne({ _id: object(event.id) }, read({ conversationId: 1 }));
            const ids = await conversation(String(row?.conversationId ?? '')); if (ids.includes(event.actor)) hub.notify(ids, 'private');
        } else if (event.kind === 'private-block' && valid(event.id)) {
            hub.notify([event.actor], 'private');
            const row = await collection(PRIVATE_MESSAGE_COLLECTIONS.pmConversations).findOne({ participants: { $all: [object(event.actor), object(event.id)] } }, read({ participants: 1 }));
            const ids = row?.participants?.map(String) ?? [];
            if (ids.length === 2 && ids.includes(event.actor) && ids.includes(event.id)) hub.notify(ids, 'private');
        }
    }
    // Failure to deliver a hint cannot turn a committed user action into a failed action.
    return event => Promise.resolve().then(() => deliver(event)).catch(() => {});
}
