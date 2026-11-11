import { ArchiveError } from './reader.mjs';

/** Mount behind the host's existing optionalAuth, never as a raw-object proxy. */
export function createArchiveHandlers({ reader, evaluateDetailsAccess, getDetailsCachePolicy,
  hasPrivilegedMatchDetailsAccess, buildDetailsLockedResponse, projectPublicDailyMatch, getNow,
  lockHours = 1, onError = () => {} }) {
  for (const fn of [evaluateDetailsAccess, getDetailsCachePolicy, hasPrivilegedMatchDetailsAccess,
    buildDetailsLockedResponse, projectPublicDailyMatch, getNow]) {
    if (typeof fn !== 'function') throw new ArchiveError('ACCESS_POLICY_REQUIRED');
  }
  const fail = (res, error) => {
    onError(error);
    const status = error instanceof ArchiveError && [400,404].includes(error.status) ? error.status : 503;
    return res.status(status).set('Cache-Control','private, no-store').json({code:status === 404 ? 'ARCHIVE_NOT_FOUND' : 'ARCHIVE_UNAVAILABLE'});
  };
  async function matchDetails(req, res, internalId = false) {
      try {
        const id = req.params.id;
        if (!(internalId ? /^[1-9][0-9]*$/ : /^[1-9][0-9]{4,11}$/).test(String(id)))
          throw new ArchiveError('INVALID_MATCH_ID',400);
        const located = internalId ? await reader.locateMatchById(id) : await reader.locateMatchByTp(id);
        if (!located) throw new ArchiveError('ARCHIVE_NOT_FOUND',404);
        const tp = located.tp;
        const {raw, decoded} = await reader.readVerified(`matches/${tp}.br`);
        let match;
        try { match = JSON.parse(decoded.toString('utf8')); } catch { throw new ArchiveError('ARCHIVE_JSON_INVALID'); }
        const access = evaluateDetailsAccess({isFinished:match.m656,
          isPrivileged:hasPrivilegedMatchDetailsAccess(req.user || null), expectedStartUtc:match.m003, now:getNow(), lockHours});
        const cache = getDetailsCachePolicy(access);
        res.set('Cache-Control',cache.cacheControl).set('X-BB-Release',reader.releaseId);
        if (cache.varyAuthorization) res.vary('Authorization');
        if (!access.allowed) return res.status(423).json(buildDetailsLockedResponse(access));
        // Existing frontend explicitly decodes Brotli. Do NOT set Content-Encoding.
        return res.type('application/octet-stream').send(raw);
      } catch (error) { return fail(res,error); }
  }
  return {
    matchDetails:(req,res) => matchDetails(req,res),
    matchById:(req,res) => matchDetails(req,res,true),
    async daily(req, res) {
      try {
        const day = req.params.date;
        const rows = await reader.readJson(`daily/${day}.br`);
        if (!Array.isArray(rows)) throw new ArchiveError('ARCHIVE_JSON_INVALID');
        const matches = rows.map(projectPublicDailyMatch);
        return res.set('Cache-Control','public, max-age=300').set('X-BB-Release',reader.releaseId)
          .json({date:day,count:matches.length,matches});
      } catch (error) { return fail(res,error); }
    },
  };
}
