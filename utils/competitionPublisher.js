import { competitionError, competitionLockAt, validateCompetitionObservation } from './competitionPolicy.js';

/** Internal trusted feed adapter. Not exposed through a public/user HTTP route.
 * Callers must obtain source-observed timestamps from the feed, not invent them
 * from ingestion time or regenerate them from historical archives. */
export async function publishCompetitionObservation({ collection, input, allowedSources, now = new Date() }) {
    const row = validateCompetitionObservation(input);
    if (!allowedSources.includes(row.source) || +new Date(row.statusObservedAt) > +now
        || +new Date(row.oddsObservedAt) > +now || (row.model && +new Date(row.model.issuedAt) > +now))
        throw competitionError('COMPETITION_INVALID_SOURCE', 400);
    const existing = await collection.findOne({ _id: row.matchTPId }, { maxTimeMS: 5000 });
    if (existing && (existing.source !== row.source || existing.sourceEventId !== row.sourceEventId || existing.oddsKind !== row.oddsKind
        || existing.players.some((p, i) => p.id !== row.players[i].id)))
        throw competitionError('COMPETITION_SOURCE_CONFLICT', 409);
    if (existing && (row.revision <= existing.revision
        || Date.parse(row.statusObservedAt) < Date.parse(existing.statusObservedAt)
        || Date.parse(row.oddsObservedAt) < Date.parse(existing.oddsObservedAt)
        || (existing.status !== 'scheduled' && row.status === 'scheduled')))
        throw competitionError('COMPETITION_SOURCE_CONFLICT', 409);
    const firstLockAt = new Date(competitionLockAt({...row,firstLockAt:existing?.firstLockAt})).toISOString();
    const document = { ...row, _id: row.matchTPId, firstLockAt,
        publishedAt: now.toISOString(), pendingSettlement: ['finished', 'cancelled', 'walkover', 'retired'].includes(row.status) };
    if (existing) {
        // Keep the original replacement contract for legacy sources. A Rally
        // heartbeat must not erase the acceptedReads increment of a concurrent pick.
        const {_id, ...fields}=document;
        const result = row.oddsKind==='model-fair'
            ? await collection.updateOne({ _id, revision:existing.revision },{$set:fields,$unset:{rallyHeld:''}},{maxTimeMS:5000})
            : await collection.replaceOne({ _id: row.matchTPId, revision: existing.revision }, document, { maxTimeMS: 5000 });
        if (!result.matchedCount) throw competitionError('COMPETITION_SOURCE_CONFLICT', 409);
    } else {
        await collection.insertOne(document, { maxTimeMS: 5000 });
    }
    return { matchTPId: row.matchTPId, revision: row.revision };
}
