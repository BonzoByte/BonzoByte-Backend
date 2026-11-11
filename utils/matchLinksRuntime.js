import Match from '../models/match.model.js';
import * as archives from '../routes/archives.routes.js';
import { createFavouritesResolver } from './favouritesResolver.js';
import { createMatchLinks, matchLinkError, validMatchLinkId } from './matchLinks.js';

const resolver = createFavouritesResolver({ Match, readBuffer: archives.readArchiveBuffer,
    locateDate: archives.locateRecoveryArchiveDate ?? null });

// Recovery uses an existing verified, read-only PRIMARY KEY lookup. Outside
// recovery, only explicit stored MatchIds are eligible: never guess a TPId.
async function locateStoredCanonical(id, { signal } = {}) {
    signal?.throwIfAborted();
    const rows = await Match.find({ matchId: id }).select('_id matchId').limit(2).maxTimeMS(3000)
        .setOptions({ strictQuery: false, timeoutMS: 3000 }).lean();
    signal?.throwIfAborted();
    if (rows.length > 1) throw matchLinkError('UNAVAILABLE');
    const row = rows[0];
    return row?.matchId === id && validMatchLinkId(row._id) ? { matchId: id, matchTPId: row._id } : null;
}
export const matchLinks = createMatchLinks({
    locateCanonical: archives.locateRecoveryMatchById ?? locateStoredCanonical,
    resolveLegacy: async (tp, options) => (await resolver.resolve([tp], options)).get(tp),
});
