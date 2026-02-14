// routes/archives.routes.js
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { brotliDecompressSync } from 'zlib';
import { canAccessFutureMatchDetails } from '../utils/entitlements.js';
import { buildDetailsLockedResponse } from '../utils/lockResponse.js';
import { optionalAuth } from '../middleware/auth.middleware.js';
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getNowDebug } from '../utils/now.js';
import { env } from '../config/env.js';

const router = Router();

/* ----------------------------- Helpers ----------------------------- */

const FIGURE_SPACE = '\u2007';
const fmtNum = (val, digitsBefore = 3, decimals = 2) => {
    if (val == null || !isFinite(val)) return '';
    const s = Number(val).toFixed(decimals);
    const [int, frac] = s.split('.');
    const pad = FIGURE_SPACE.repeat(Math.max(0, digitsBefore - int.length));
    return `${pad}${int}.${frac}`;
};

const displaySurface = (name = '') => {
    const s = String(name || '').trim();
    if (!s) return '';
    return /^(?:unknown|unk|n\/a|na|none|-|0)$/i.test(s) ? '' : s;
};

const cleanTournamentName = (name = '') =>
    String(name || '')
        .replace(/\s*(?:\([^()]*\)\s*)+$/g, '')
        .replace(/\s*(?:[IVXLCDM]{1,4})\s*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

const cleanIso3ForDisplay = (iso3 = '') => {
    const s = String(iso3 || '').toUpperCase().trim();
    if (!s || s === 'WLD' || s === 'NA' || s === 'N/A' || s === '---') return '';
    return /^[A-Z]{3}$/.test(s) ? s : '';
};

const playerLabel = (name = '', seed = '', iso3 = '') => {
    const seedPart = seed ? ` [${seed}]` : '';
    const iso = cleanIso3ForDisplay(iso3);
    const isoPart = iso ? ` (${iso})` : '';
    return `${name}${seedPart}${isoPart}`.trim();
};

const formatResult = (r = '') => (r && r.length === 2 ? `${r[0]}:${r[1]}` : '');

const formatResultDetails = (s = '') =>
    String(s || '')
        .split(' ')
        .filter(Boolean)
        .map((tok) => {
            const m = tok.match(/^(\d)(\d)(\(.+?\))?$/);
            return m ? `${m[1]}:${m[2]}${m[3] || ''}` : tok;
        })
        .join(' ');

const dashPairAligned = (a, b, decimals = 2) => {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) {
        return { left: '', right: '', text: '' };
    }
    const left = fmtNum(a, 3, decimals);
    const right = fmtNum(b, 3, decimals);
    return { left, right, text: `${left} - ${right}` };
};

const yyyymmddToIso = (yyyymmdd) =>
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

const lockHours = env.DETAILS_LOCK_HOURS ?? 2;

const allowed = canAccessFutureMatchDetails(user, expectedStartUtc, lockHours);
if (!allowed) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-BB-Guard', '1');
    return res.status(423).json(buildDetailsLockedResponse(expectedStartUtc, lockHours));
}

/* ------------------------------ Config ----------------------------- */

const ARCHIVES_SOURCE = String(process.env.ARCHIVES_SOURCE || 'remote').trim().toLowerCase(); // 'remote' | 'local'
const ARCHIVES_BASE_URL = process.env.ARCHIVES_BASE_URL || ''; // legacy

// local dirs (samo za local mode)
const DAILY_DIR = process.env.BROTLI_DAILY_DIR || 'd:\\BrotliArchives\\DayliMatches';
const MATCH_DETAILS_DIR = process.env.BROTLI_MATCH_DETAILS_DIR || 'd:\\BrotliArchives\\MatchDetails';

const PLAYERS_INDEX_DIR =
    process.env.BROTLI_PLAYERS_INDEX_DIR ||
    'd:\\Development\\My Projects\\BonzoByteRoot\\StaticFiles\\Data\\archives\\players\\indexBuild';

const TOURNAMENTS_INDEX_DIR =
    process.env.BROTLI_TOURNAMENTS_INDEX_DIR ||
    'd:\\Development\\My Projects\\BonzoByteRoot\\StaticFiles\\Data\\archives\\tournaments\\indexBuild';

const R2 = {
    bucket: process.env.R2_BUCKET || '',
    accountId: process.env.R2_ACCOUNT_ID || '',
    endpoint:
        process.env.R2_ENDPOINT ||
        (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''),
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
};

function assertR2Configured() {
    const required = ['R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
    const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
    if (missing.length) {
        const msg = `R2 S3 not configured, missing: ${missing.join(', ')}`;
        const err = new Error(msg);
        err.statusCode = 500;
        throw err;
    }
}

if (ARCHIVES_SOURCE === 'remote') {
    assertR2Configured();
}

const s3 =
    ARCHIVES_SOURCE === 'remote' && R2.bucket && R2.endpoint && R2.accessKeyId && R2.secretAccessKey
        ? new S3Client({
            region: 'auto',
            endpoint: R2.endpoint,
            forcePathStyle: true,
            credentials: { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
        })
        : null;

/* --------------------------- IO utilities --------------------------- */

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function fetchRemoteBrToBuffer(key) {
    if (!s3) throw new Error('R2 S3 is not configured for reading');
    const out = await s3.send(new GetObjectCommand({ Bucket: R2.bucket, Key: key }));
    if (!out.Body) throw new Error(`Empty body for key: ${key}`);
    return await streamToBuffer(out.Body);
}

async function r2GetObjectBufferWithMeta(key) {
    if (!s3) throw new Error("R2 S3 is not configured for reading");

    try {
        const out = await s3.send(new GetObjectCommand({ Bucket: R2.bucket, Key: key }));
        if (!out?.Body) return null;

        const body = await streamToBuffer(out.Body);
        return {
            body,
            contentType: out.ContentType ?? null,
        };
    } catch (e) {
        // 404 u AWS SDK obično dođe kao error -> samo vrati null
        if (String(e?.name).includes("NoSuchKey") || e?.$metadata?.httpStatusCode === 404) return null;
        return null; // ili throw ako želiš vidjeti realne greške
    }
}

async function readArchiveBuffer(kind, name) {
    if (ARCHIVES_SOURCE === 'local') {
        const filePath = path.join(kind === 'daily' ? DAILY_DIR : MATCH_DETAILS_DIR, `${name}.br`);
        await fs.promises.access(filePath, fs.constants.R_OK);
        return await fs.promises.readFile(filePath);
    }

    const key = kind === 'daily' ? `daily/${name}.br` : `matches/${name}.br`;
    return await fetchRemoteBrToBuffer(key);
}

async function listDailyBrFiles() {
    if (ARCHIVES_SOURCE === 'local') {
        const files = await fs.promises.readdir(DAILY_DIR);
        return files.filter((f) => /^\d{8}\.br$/i.test(f)).sort((a, b) => a.localeCompare(b));
    }

    if (!s3) throw new Error('R2 S3 is not configured for listing');

    const Prefix = 'daily/';
    const keys = [];
    let ContinuationToken;

    do {
        const out = await s3.send(
            new ListObjectsV2Command({
                Bucket: R2.bucket,
                Prefix,
                ContinuationToken,
            })
        );

        (out.Contents || []).forEach((obj) => {
            if (obj.Key && /\.br$/i.test(obj.Key)) keys.push(obj.Key);
        });

        ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);

    return keys
        .map((k) => k.substring(Prefix.length))
        .filter((name) => /^\d{8}\.br$/i.test(name))
        .sort((a, b) => a.localeCompare(b));
}

async function listIndexBrFiles(entity) {
    if (ARCHIVES_SOURCE === 'local') {
        const dir = entity === 'players' ? PLAYERS_INDEX_DIR : TOURNAMENTS_INDEX_DIR;
        const files = await fs.promises.readdir(dir);
        return files.filter((f) => /\.br$/i.test(f)).sort((a, b) => a.localeCompare(b));
    }

    if (!s3) throw new Error('R2 S3 is not configured for listing');

    const Prefix = `${entity}/indexBuild/`;
    const keys = [];
    let ContinuationToken;

    do {
        const out = await s3.send(
            new ListObjectsV2Command({
                Bucket: R2.bucket,
                Prefix,
                ContinuationToken,
            })
        );

        (out.Contents || []).forEach((obj) => {
            if (obj.Key && /\.br$/i.test(obj.Key)) keys.push(obj.Key);
        });

        ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);

    return keys
        .map((k) => k.substring(Prefix.length))
        .filter((name) => name && /\.br$/i.test(name))
        .sort((a, b) => a.localeCompare(b));
}

async function getLatestIndexFile(entity) {
    const files = await listIndexBrFiles(entity);
    return files.length ? files[files.length - 1] : null;
}

async function readIndexBuffer(entity, file) {
    // entity: 'players' | 'tournaments'
    const safe = String(file || '').trim();
    if (!safe || safe.includes('..') || safe.includes('/') || safe.includes('\\')) {
        const err = new Error('Invalid index file name.');
        err.statusCode = 400;
        throw err;
    }
    if (!/\.br$/i.test(safe)) {
        const err = new Error('Index file must end with .br');
        err.statusCode = 400;
        throw err;
    }

    if (ARCHIVES_SOURCE === 'local') {
        const dir = entity === 'players' ? PLAYERS_INDEX_DIR : TOURNAMENTS_INDEX_DIR;
        const filePath = path.join(dir, safe);
        await fs.promises.access(filePath, fs.constants.R_OK);
        return await fs.promises.readFile(filePath);
    }

    const key = `${entity}/indexBuild/${safe}`;
    return await fetchRemoteBrToBuffer(key);
}

async function buildManifest(entity) {
    const files = await listIndexBrFiles(entity);
    if (!files.length) return { entity, count: 0, latest: null, files: [] };

    const latest = files[files.length - 1]; // asc sort -> zadnji je najnoviji po imenu (ako verzija u nazivu raste)
    return { entity, count: files.length, latest, files };
}

async function getDailyDateRange() {
    const br = await listDailyBrFiles();
    if (!br.length) return null;

    const first = br[0].replace(/\.br$/i, '');
    const last = br[br.length - 1].replace(/\.br$/i, '');
    return { minDate: yyyymmddToIso(first), maxDate: yyyymmddToIso(last) };
}

async function serveMatchDetails(req, res) {
    const allowed = canAccessFutureMatchDetails(user, expectedStartUtc, DETAILS_LOCK_HOURS);
    if (!allowed) {
      return res.status(423).json(buildDetailsLockedResponse(expectedStartUtc, DETAILS_LOCK_HOURS));
    }    

    const brBuf = await readArchiveBuffer('match', id);
    const rawBuf = brotliDecompressSync(brBuf);
    const text = rawBuf.toString('utf8').replace(/^\uFEFF/, '');

    const json = JSON.parse(text);

    const expectedStartUtc = json?.m003;
    const isFinished = !!json?.m656;

    if (!isFinished) {
        const user = req.user || null;
        const allowed = canAccessFutureMatchDetails(user, expectedStartUtc, DETAILS_LOCK_HOURS);

        if (!allowed) {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-BB-Route', 'match-details');
            return res.status(423).json(buildDetailsLockedResponse(user, expectedStartUtc, DETAILS_LOCK_HOURS));
        }
    }

    if (String(req.query.download || '').toLowerCase() === '1') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-BB-Route', 'match-details');
        return res.send(text);
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-BB-Route', 'match-details');
    return res.json(json);
}

/* ------------------------------- Routes ---------------------------- */

router.get('/_debug/config', (_req, res) => {
    res.json({
        ARCHIVES_SOURCE,
        R2: {
            bucket: R2.bucket,
            endpoint: R2.endpoint,
            hasAccessKey: !!R2.accessKeyId,
            hasSecret: !!R2.secretAccessKey,
            s3Enabled: !!s3,
        },
    });
});

router.get('/debug/now', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...getNowDebug() });
});

router.get('/_debug/r2-list', async (req, res, next) => {
    try {
        if (ARCHIVES_SOURCE !== 'remote') {
            return res.status(400).json({ error: 'ARCHIVES_SOURCE is not remote', ARCHIVES_SOURCE });
        }
        if (!s3) return res.status(500).json({ error: 's3 client is null' });

        const prefix = String(req.query.prefix ?? 'daily/').toString();
        const max = Math.min(parseInt(req.query.max ?? '20', 10), 200);

        const out = await s3.send(
            new ListObjectsV2Command({
                Bucket: R2.bucket,
                Prefix: prefix,
                MaxKeys: max,
            })
        );

        const keys = (out.Contents ?? []).map((o) => o.Key);

        res.json({
            bucket: R2.bucket,
            prefix,
            keyCount: keys.length,
            sample: keys.slice(0, 50),
            isTruncated: !!out.IsTruncated,
        });
    } catch (e) {
        next(e);
    }
});

// GET /api/archives/latest-daily
router.get('/latest-daily', async (_req, res) => {
    try {
        const br = await listDailyBrFiles();
        if (!br.length) return res.status(404).json({ message: 'No .br files found.' });

        br.sort((a, b) => b.localeCompare(a));
        const latest = br[0];
        const date = latest.replace(/\.br$/i, '');
        const iso = yyyymmddToIso(date);

        res.json({
            date,
            iso,
            filename: latest,
            source: ARCHIVES_SOURCE,
            baseUrl: ARCHIVES_SOURCE === 'remote' ? ARCHIVES_BASE_URL : undefined,
        });
    } catch (e) {
        console.error('❌ /archives/latest-daily error:', e);
        res.status(500).json({ message: 'Failed to list archives.' });
    }
});

// GET /api/archives/daterange  -> { minDate, maxDate }
router.get('/daterange', async (_req, res) => {
    try {
        const range = await getDailyDateRange();
        if (!range) return res.status(404).json({ message: 'No .br files found.' });
        res.json(range);
    } catch (e) {
        console.error('❌ /archives/daterange error:', e);
        res.status(500).json({ message: 'Failed to list archives.' });
    }
});

// GET /api/archives/available-dates  -> ["YYYY-MM-DD", ...] asc
router.get('/available-dates', async (_req, res) => {
    try {
        const br = await listDailyBrFiles();
        const dates = br.map((f) => yyyymmddToIso(f.replace(/\.br$/i, '')));
        res.json(dates);
    } catch (e) {
        console.error('❌ /archives/available-dates error:', e);
        res.status(500).json({ message: 'Failed to list archives.' });
    }
});

// Angular: /daily/index.json
router.get('/daily/index.json', async (_req, res) => {
    try {
        const range = await getDailyDateRange();
        if (!range) return res.status(404).json({ message: 'No .br files found.' });

        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json(range);
    } catch (e) {
        console.error('❌ /archives/daily/index.json error:', e);
        res.status(500).json({ message: 'Failed to read daterange.' });
    }
});

// GET /api/archives/daily/:date  (date = "YYYYMMDD")
router.get('/daily/:date', async (req, res) => {
    const date = String(req.params.date || '').trim().replace(/\.br$/i, '');
    if (!/^\d{8}$/.test(date)) return res.status(400).json({ message: 'Invalid date format.' });

    try {
        const brBuf = await readArchiveBuffer('daily', date);
        const jsonBuf = brotliDecompressSync(brBuf);
        const text = jsonBuf.toString('utf8');

        const rows = JSON.parse(text);
        if (!Array.isArray(rows)) {
            return res.status(500).json({ message: 'Archive content is not an array.' });
        }

        const matches = rows.map((m) => {
            const tourNameClean = cleanTournamentName(m.tournamentEventName || '');
            const iso3 = (m.tournamentEventCountryISO3 || '').toUpperCase();
            const countrySuffix = iso3 && iso3 !== 'WLD' ? ` (${iso3})` : '';
            const tournamentTitle = tourNameClean + countrySuffix;

            const player1LabelText = playerLabel(m.player1Name || '', m.player1Seed || '', m.player1CountryISO3 || '');
            const player2LabelText = playerLabel(m.player2Name || '', m.player2Seed || '', m.player2CountryISO3 || '');

            const resultText = formatResult(m.result || '');
            const resultDetailsText = formatResultDetails(m.resultDetails || '');

            const odds = dashPairAligned(m.player1Odds, m.player2Odds, 2);
            const probs = dashPairAligned(m.winProbabilityPlayer1NN, m.winProbabilityPlayer2NN, 2);

            return {
                ...m,
                tournamentType: m.tournamentTypeName,
                tournamentLevel: m.tournamentLevelName,
                surface: displaySurface(m.matchSurfaceName || m.tournamentEventSurfaceName || ''),
                tournamentTitle,
                player1Label: player1LabelText,
                player2Label: player2LabelText,
                resultText,
                resultDetailsText,
                oddsText: odds.text,
                oddsLeft: odds.left,
                oddsRight: odds.right,
                probabilityText: probs.text,
                probLeft: probs.left,
                probRight: probs.right,
            };
        });

        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json({ date, count: matches.length, matches });
    } catch (e) {
        console.error('❌ /archives/daily error:', e);
        res.status(500).json({ message: 'Failed to read/decompress archive.' });
    }
});

// ✅ legacy: /api/archives/matches/:id (guarded!)
router.get('/matches/:id', optionalAuth, async (req, res) => {
    try {
        return await serveMatchDetails(req, res);
    } catch (e) {
        console.error('❌ /archives/matches error:', e);
        return res.status(500).json({ message: 'Failed to read/decompress archive.' });
    }
});

// ✅ frontend alias: /api/archives/match-details/:id (guarded!)
router.get('/match-details/:id', optionalAuth, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!/^\d{5,12}$/.test(id)) {
        return res.status(400).json({ message: 'Invalid id format.' });
      }
  
      const brBuf = await readArchiveBuffer('match', id);
      const rawBuf = brotliDecompressSync(brBuf);
      const text = rawBuf.toString('utf8').replace(/^\uFEFF/, '');
      const json = JSON.parse(text);
  
      const expectedStartUtc = json?.m003;     // npr. "2016-01-04T10:30:00"
      const isFinished = !!json?.m656;
  
      if (!isFinished) {
        const user = req.user || null;
      }

      const DETAILS_LOCK_HOURS = Number(env.DETAILS_LOCK_HOURS ?? 2);
  
      if (String(req.query.download || '').toLowerCase() === '1') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.send(text);
      }
  
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(json);
    } catch (e) {
      console.error('❌ /archives/match-details error:', e);
      return res.status(500).json({ message: 'Failed to read/decompress archive.' });
    }
  });  

router.get('/debug/lock/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!/^\d{5,12}$/.test(id)) return res.status(400).json({ message: 'Invalid id format.' });

        const brBuf = await readArchiveBuffer('match', id);
        const rawBuf = brotliDecompressSync(brBuf);
        const text = rawBuf.toString('utf8').replace(/^\uFEFF/, '');
        const json = JSON.parse(text);

        const expectedStartUtc = json?.m003;
        const isFinished = !!json?.m656;

        const now = getNow();
        const start = new Date(expectedStartUtc);
        const unlockAt = new Date(start.getTime() - DETAILS_LOCK_HOURS * 60 * 60 * 1000);

        const allowedAsGuest = isFinished ? true : canAccessFutureMatchDetails(null, expectedStartUtc, 2);

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-BB-Debug', '1');

        return res.json({
            ok: true,
            id,
            forcedNowIso: process.env.ARCHIVES_NOW_ISO ?? null,
            nowIso: now.toISOString(),
            expectedStartUtc,
            startIso: isNaN(start.getTime()) ? null : start.toISOString(),
            unlockAtIso: isNaN(unlockAt.getTime()) ? null : unlockAt.toISOString(),
            isFinished,
            allowedAsGuest,
            lockedResponseExample: buildDetailsLockedResponse(expectedStartUtc, 2),
        });
    } catch (e) {
        console.error('debug lock error', e);
        return res.status(500).json({ message: 'debug lock failed' });
    }
});

function maybeDownload(req, res, id, text, json) {
    if (String(req.query.download || '').toLowerCase() === '1') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`);
        return res.send(text);
    }
    return res.json(json);
}

/* Local-only endpoints (Render remote mode neće imati te fajlove) */

import zlib from "zlib";

router.get("/ts/:playerTPId", async (req, res) => {
    try {
        const id = req.params.playerTPId;
        const key = `players/ts/${id}.br`;

        console.log('[ts] key:', key);

        const brBuffer = await r2GetObjectBuffer(key);
        if (!brBuffer) return res.status(404).json({ ok: false, reason: "missing" });

        const jsonBuffer = zlib.brotliDecompressSync(brBuffer);
        const data = JSON.parse(jsonBuffer.toString("utf-8"));

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.json({ ok: true, playerTPId: Number(id), data });
    } catch (e) {
        console.error("[ts] error:", e);
        res.status(500).json({ ok: false });
    }
});

// GET /api/archives/players/manifest
router.get('/players/manifest', async (_req, res, next) => {
    try {
        const range = await getDailyDateRange(); // već postoji u tvom fileu
        const latest = await getLatestIndexFile('players');

        if (!range) return res.status(404).json({ message: 'No daily archives found.' });
        if (!latest) return res.status(404).json({ message: 'No players index files found.' });

        const version = extractVersionFromIndexFile(latest);

        // DailyManifest shape
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.json({
            minDate: range.minDate,
            maxDate: range.maxDate,
            generatedAtUtc: new Date().toISOString(),
            players: {
                version: version || latest,
                url: latest,              // <-- frontend očekuje samo filename
                contentType: 'application/octet-stream',
            },
        });
    } catch (e) {
        next(e);
    }
});

router.get('/players/index/:file', async (req, res, next) => {
    try {
        const file = String(req.params.file || '').trim();

        const brBuf = await readIndexBuffer('players', file); // čita lokalno ili s R2
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Type', 'application/octet-stream');
        return res.send(brBuf);
    } catch (e) {
        next(e);
    }
});

// GET /api/archives/tournaments/manifest
router.get('/tournaments/manifest', async (_req, res, next) => {
    try {
        const range = await getDailyDateRange();
        const latest = await getLatestIndexFile('tournaments');

        if (!range) return res.status(404).json({ message: 'No daily archives found.' });
        if (!latest) return res.status(404).json({ message: 'No tournaments index files found.' });

        const version = extractVersionFromIndexFile(latest);

        // DailyManifestTournaments shape
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.json({
            minDate: range.minDate,
            maxDate: range.maxDate,
            generatedAtUtc: new Date().toISOString(),
            tournaments: {
                version: version || latest,
                url: latest,
                contentType: 'application/octet-stream',
            },
            tournamentStrength: null, // za sad, dok ne dodamo remote strength index
        });
    } catch (e) {
        next(e);
    }
});

router.get('/tournaments/index/:file', async (req, res, next) => {
    try {
        const file = String(req.params.file || '').trim();

        const brBuf = await readIndexBuffer('tournaments', file);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Type', 'application/octet-stream');
        return res.send(brBuf);
    } catch (e) {
        next(e);
    }
});

router.get('/status', async (_req, res, next) => {
    try {
        const range = await getDailyDateRange(); // već postoji
        const latestDaily = await (async () => {
            const br = await listDailyBrFiles(); // već postoji
            if (!br.length) return null;
            br.sort((a, b) => b.localeCompare(a));
            return br[0].replace(/\.br$/i, '');
        })();

        const latestPlayersIndex = await getLatestIndexFile('players');
        const latestTournamentsIndex = await getLatestIndexFile('tournaments');

        const payload = {
            ok: true,
            source: ARCHIVES_SOURCE,
            bucket: ARCHIVES_SOURCE === 'remote' ? R2.bucket : null,
            endpoint: ARCHIVES_SOURCE === 'remote' ? R2.endpoint : null,

            daily: {
                range: range ?? null,
                latest: latestDaily ? { yyyymmdd: latestDaily, iso: yyyymmddToIso(latestDaily) } : null,
            },

            indexes: {
                players: latestPlayersIndex ? { latest: latestPlayersIndex } : null,
                tournaments: latestTournamentsIndex ? { latest: latestTournamentsIndex } : null,
            },

            checks: null,
            nowUtc: new Date().toISOString(),
        };

        // Remote: napravi 2-3 HEAD provjere da odmah znamo da objekt stvarno postoji
        if (ARCHIVES_SOURCE === 'remote') {
            const checks = [];

            if (latestDaily) checks.push(headRemote(`daily/${latestDaily}.br`));
            // matches sample: uzmi 1 key iz matches/ ako želiš, ali je skuplje listati.
            if (latestPlayersIndex) checks.push(headRemote(`players/indexBuild/${latestPlayersIndex}`));
            if (latestTournamentsIndex) checks.push(headRemote(`tournaments/indexBuild/${latestTournamentsIndex}`));

            payload.checks = await Promise.allSettled(checks).then((results) =>
                results.map((r) => (r.status === 'fulfilled' ? { ok: true, ...r.value } : { ok: false, error: String(r.reason) }))
            );
        }

        res.setHeader('Cache-Control', 'no-store');
        return res.json(payload);
    } catch (e) {
        next(e);
    }
});

// /api/archives/players/photo/:playerTPId
router.get("/players/photo/:id", async (req, res) => {
    try {
        const id = String(req.params.id || "").trim();

        // "photoM.jpg" / "photoW.jpg" -> direktno serve
        if (id === "photoM.jpg" || id === "photoW.jpg") {
            const key = `players/photo/${id}`;
            const found = await r2GetObjectBufferWithMeta(key); // vidi helper niže
            if (!found) return res.status(404).end();
            res.setHeader("Content-Type", found.contentType ?? "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
            return res.send(found.body);
        }

        // normal player jpg (bez ekstenzije)
        const key = `players/photo/${id}.jpg`;
        const found = await r2GetObjectBufferWithMeta(key);

        if (!found) {
            // fallback: ako player nema sliku, vrati default (ovdje biramo W/M po prefiksu ili query paramu)
            // Najbolje: frontend pošalje ?g=W ili ?g=M
            const g = String(req.query.g || "M").toUpperCase() === "W" ? "W" : "M";
            return res.redirect(302, `/api/archives/players/photo/photo${g}.jpg`);
        }

        res.setHeader("Content-Type", found.contentType ?? "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
        return res.send(found.body);
    } catch (e) {
        console.error("players/photo failed", e);
        return res.status(500).json({ ok: false });
    }
});

function extractVersionFromIndexFile(file) {
    // players.index.v2026-01-22T19-35Z.br -> v2026-01-22T19-35Z
    const m = String(file || '').match(/\.(v\d{4}-\d{2}-\d{2}T\d{2}-\d{2}Z)\.br$/i);
    return m ? m[1] : '';
}

async function headRemote(key) {
    if (!s3) throw new Error('R2 S3 is not configured');
    const out = await s3.send(new HeadObjectCommand({ Bucket: R2.bucket, Key: key }));
    return {
        key,
        size: out.ContentLength ?? null,
        lastModified: out.LastModified ? new Date(out.LastModified).toISOString() : null,
        contentType: out.ContentType ?? null,
        etag: out.ETag ?? null,
    };
}

function isNotFound(err) {
    const name = err?.name || '';
    const code = err?.Code || err?.code || err?.$metadata?.httpStatusCode;
    const http = err?.$metadata?.httpStatusCode;

    return (
        http === 404 ||
        code === 404 ||
        code === 'NotFound' ||
        code === 'NoSuchKey' ||
        name === 'NoSuchKey' ||
        name === 'NotFound'
    );
}

async function getRemoteObject(key) {
    if (!s3) throw new Error('R2 S3 is not configured');

    const out = await s3.send(new GetObjectCommand({ Bucket: R2.bucket, Key: key }));
    if (!out?.Body) throw new Error(`Empty body for key: ${key}`);

    const body = await streamToBuffer(out.Body);
    return {
        key,
        body, // Buffer
        contentType: out.ContentType ?? null,
        etag: out.ETag ?? null,
    };
}

async function r2GetObjectBuffer(key) {
    if (ARCHIVES_SOURCE !== 'remote') return null; // (ili implementiraj local ako želiš)
    try {
        return await fetchRemoteBrToBuffer(key);
    } catch (e) {
        // Ako objekt ne postoji, AWS SDK baca grešku tipa NoSuchKey / 404.
        // Mi to tretiramo kao "not found", ne kao 500.
        const name = String(e?.name || '');
        const status = e?.$metadata?.httpStatusCode;

        if (name === 'NoSuchKey' || status === 404) return null;
        throw e; // ostalo je pravi fail
    }
}

export default router;