import { Router } from 'express';
import { ArchiveError } from '../utils/private-archive-reader/reader.mjs';
import { createArchiveHandlers } from '../utils/private-archive-reader/archive-handlers.mjs';
import { privateArchiveRuntime } from '../utils/privateArchiveRuntime.js';
import { projectPublicDailyMatch } from '../utils/publicDailyMatch.js';
import { parseSimulationArchiveName } from '../utils/simulationArchiveManifest.js';

const PRIVATE = 'private, no-store';
const missing = () => new ArchiveError('ARCHIVE_NOT_FOUND', 404);
const invalid = () => new ArchiveError('INVALID_ARCHIVE_REQUEST', 400);
const integrity = () => new ArchiveError('ARCHIVE_INTEGRITY');
const indexPattern = entity => new RegExp(`^${entity}\\.(?:reviewed|rally)\\.[a-f0-9]{16}\\.br$`);

function identifier(value, minimum = 1, maximum = 12) {
    const text = String(value ?? '');
    if (!new RegExp(`^[1-9][0-9]{${minimum - 1},${maximum - 1}}$`).test(text)
        || !Number.isSafeInteger(Number(text))) throw invalid();
    return text;
}
function dailyDate(value) {
    const compact = String(value ?? '').replace(/\.br$/i, '');
    if (!/^\d{8}$/.test(compact)) throw invalid();
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw invalid();
    return compact;
}

// Delayed imports avoid global env validation/DB models merely to import this provider.
async function hostOptionalAuth(req, res, next) {
    try { return await (await import('../middleware/optionalAuth.js')).optionalAuth(req, res, next); }
    catch (error) { return next(error); }
}
async function hostAccessPolicies() {
    const modules = await Promise.all([
        import('../utils/detailsAccessPolicy.js'), import('../utils/entitlements.js'),
        import('../utils/lockResponse.js'), import('../utils/now.js'),
    ]);
    return Object.assign({}, ...modules, { projectPublicDailyMatch });
}

/** Mount at /api/archives only for publisher mode, behind the host's beta gate. */
export function createPrivateArchivesRouter({ runtime = privateArchiveRuntime, reader,
    optionalAuth = hostOptionalAuth, loadAccessPolicies = hostAccessPolicies,
    settings = process.env, onError = () => {} } = {}) {
    const router = Router();
    const getReader = reader ? async () => reader : runtime.getReader;
    const reportError = error => { try { onError(error); } catch { /* Logging must not expose/replace a response. */ } };
    function fail(res, error) {
        reportError(error);
        const status = error instanceof ArchiveError && [400, 404].includes(error.status) ? error.status : 503;
        res.removeHeader('Content-Encoding');
        res.removeHeader('Content-Disposition');
        return res.status(status).set('Cache-Control', PRIVATE).json({
            code: status === 404 ? 'ARCHIVE_NOT_FOUND' : status === 400 ? 'INVALID_ARCHIVE_REQUEST' : 'ARCHIVE_UNAVAILABLE',
        });
    }
    router.use(async (req, res, next) => {
        res.set('Cache-Control', PRIVATE).set('X-BB-Release', 'unavailable');
        res.vary('Authorization');
        try {
            res.locals.privateArchiveReader = await getReader();
            res.set('X-BB-Release', res.locals.privateArchiveReader.releaseId);
            next();
        } catch (error) { fail(res, error); }
    });
    const route = handler => async (req, res) => {
        try { return await handler(req, res, res.locals.privateArchiveReader); }
        catch (error) { return fail(res, error); }
    };
    const range = async archive => {
        const dates = await archive.availableDates();
        if (!dates.length) throw missing();
        return { minDate: dates[0], maxDate: dates.at(-1) };
    };
    const binary = (res, buffer, id, tag) => {
        if (id) res.set('Content-Disposition', `inline; filename="${id}.br"`);
        if (tag) res.set('X-BB-Route', tag);
        return res.type('application/octet-stream').send(buffer);
    };

    router.get('/available-dates', route(async (_req, res, archive) => res.json(await archive.availableDates())));
    router.get('/latest-daily', route(async (_req, res, archive) => {
        const { maxDate: iso } = await range(archive), date = iso.replaceAll('-', '');
        return res.json({ date, iso, filename: `${date}.br`, source: 'publisher' });
    }));
    for (const path of ['/daterange', '/daily/index.json'])
        router.get(path, route(async (_req, res, archive) => res.json(await range(archive))));
    router.get('/daily/:date', route(async (req, res, archive) => {
        const date = dailyDate(req.params.date);
        const rows = await archive.readJson(`daily/${date}.br`);
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw integrity();
        const matches = rows.map(projectPublicDailyMatch);
        return res.json({ date, count: matches.length, matches });
    }));

    const details = route(async (req, res, archive) => {
        req.params.id = identifier(req.params.id, 5);
        const policies = await loadAccessPolicies();
        const lockHours = Number(settings.DETAILS_LOCK_HOURS ?? 1);
        if (!Number.isInteger(lockHours) || lockHours < 0 || lockHours > 24) throw integrity();
        // Keep host access/lock semantics; beta overrides even universally unlocked caching.
        const handlers = createArchiveHandlers({ ...policies, reader: archive, lockHours, onError: reportError,
            getDetailsCachePolicy: access => ({ ...policies.getDetailsCachePolicy(access), cacheControl: PRIVATE }),
            buildDetailsLockedResponse: access => {
                res.set('X-BB-Guard', '1');
                res.removeHeader('Content-Disposition');
                return policies.buildDetailsLockedResponse(access);
            },
        });
        res.set('X-BB-Route', 'match-details');
        res.set('Content-Disposition', `inline; filename="${req.params.id}.br"`);
        await handlers.matchDetails(req, res);
    });
    for (const path of ['/matches/:id', '/match-details/:id']) router.get(path, optionalAuth, details);

    for (const [path, kind, param, auth, tag] of [
        ['/players/details/:playerTPId', 'player-details', 'playerTPId', false, null],
        ['/players/matches/:playerTPId', 'players/matches', 'playerTPId', true, 'player-matches'],
        ['/players/ts/:playerTPId', 'players/ts', 'playerTPId', true, 'player-ts'],
        ['/tournaments/matches/:tournamentEventTPId', 'tournaments/matches', 'tournamentEventTPId', true, 'player-matches'],
    ]) {
        const handler = route(async (req, res, archive) => {
            const id = identifier(req.params[param]);
            return binary(res, await archive.read(kind, id), id, tag);
        });
        router.get(path, ...(auth ? [optionalAuth] : []), handler);
    }
    router.get('/ts/:playerTPId', route(async (req, res, archive) => {
        const id = identifier(req.params.playerTPId);
        return res.json({ ok: true, playerTPId: Number(id), data: await archive.readJson(`players/ts/${id}.br`) });
    }));

    for (const entity of ['players', 'tournaments']) {
        router.get(`/${entity}/manifest`, route(async (_req, res, archive) => {
            const manifest = await archive.index(entity);
            if (!indexPattern(entity).test(manifest?.[entity]?.url ?? '')) throw integrity();
            // Original full index snapshot, not a newly synthesized one-day index.
            return res.json(manifest);
        }));
        router.get(`/${entity}/index/:file`, route(async (req, res, archive) => {
            const file = req.params.file;
            if (!indexPattern(entity).test(file)) throw invalid();
            return binary(res, await archive.readRelative(`${entity}/indexBuild/${file}`));
        }));
    }

    const analyticsManifest = 'analytics/manifest.analytics.json';
    const simulationManifest = 'simulation/prediction-simulation.v4.manifest.json';
    const analyticsFile = async archive => {
        const manifest = await archive.readJson(analyticsManifest);
        const file = manifest?.analytics?.url;
        if (typeof file !== 'string' || !/^analytics\.dashboard\.v\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z\.br$/i.test(file)) throw integrity();
        return `analytics/${file}`;
    };
    const simulationFile = async archive => {
        const manifest = await archive.readJson(simulationManifest);
        return `simulation/${parseSimulationArchiveName(Buffer.from(JSON.stringify(manifest)))}`;
    };
    router.get('/analytics/manifest', route(async (_req, res, archive) => res.json(await archive.readJson(analyticsManifest))));
    for (const path of ['/analytics/dashboard', '/analytics/report'])
        router.get(path, route(async (_req, res, archive) => binary(res, await archive.readRelative(await analyticsFile(archive)))));
    router.get('/model-insights/explainability', route(async (_req, res, archive) =>
        res.json(await archive.readJson('analytics/model-explainability.v1.json'))));
    router.get('/simulation/manifest', route(async (_req, res, archive) => res.json(await archive.readJson(simulationManifest))));
    router.get('/simulation/report', route(async (_req, res, archive) => {
        const buffer = await archive.readRelative(await simulationFile(archive));
        return res.type('application/json').set('Content-Encoding', 'br').send(buffer);
    }));
    router.get('/status', route(async (_req, res, archive) => res.json({
        ok: true, source: 'publisher', release: archive.releaseId, through: archive.through,
    })));

    // Unknown/out-of-preview paths must never fall through into the legacy provider.
    router.use((_req, res) => fail(res, missing()));
    router.use((error, _req, res, _next) => fail(res, error));
    return router;
}

export default createPrivateArchivesRouter();
