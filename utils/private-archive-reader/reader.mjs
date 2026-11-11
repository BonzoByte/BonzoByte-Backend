import { createHash } from 'node:crypto';
import { brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const decompress = promisify(brotliDecompress);
const PREFIX = 'publisher-staging-v1/objects/';
const HEX = /^[a-f0-9]{64}$/;
const SHARD = /^[a-f0-9]{3}$/;
const MAX_PAYLOAD = 128 * 1024 * 1024;
const MAX_METADATA = 8 * 1024 * 1024;
const safePaths = /^(?:matches\/[1-9][0-9]*\.br|daily\/(?:[0-9]{8}\.br|index\.json|manifest(?:\.tournaments)?\.json)|players\/(?:lite|ts|details|matches)\/[1-9][0-9]*\.br|tournaments\/(?:lite|matches)\/[1-9][0-9]*\.br|players\/indexBuild\/(?:players\.(?:reviewed|rally)\.[a-f0-9]{16}\.br|manifest\.json)|tournaments\/indexBuild\/(?:tournaments\.(?:reviewed|rally)\.[a-f0-9]{16}\.br|manifest\.tournaments\.json)|(?:analytics|model-insights|simulation)\/[A-Za-z0-9._/-]+\.(?:br|json))$/;

export class ArchiveError extends Error {
  constructor(code, status = 503) { super(code); this.name = 'ArchiveError'; this.code = code; this.status = status; }
}
const check = (ok, code = 'ARCHIVE_INTEGRITY') => { if (!ok) throw new ArchiveError(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const shardOf = value => hash(String(value)).slice(0, 3);
const own = (obj, key) => Object.hasOwn(obj, key) ? obj[key] : undefined;
const positive = n => Number.isSafeInteger(n) && n > 0;
const isoDate = text => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) &&
  Number.isFinite(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text;

function logicalPath(value) {
  if (typeof value !== 'string' || !safePaths.test(value) || value.split('/').some(x => ['', '.', '..'].includes(x)))
    throw new ArchiveError('INVALID_ARCHIVE_PATH', 400);
  if (/^daily\/\d{8}\.br$/.test(value)) {
    const d = value.slice(6, 14);
    if (!isoDate(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`)) throw new ArchiveError('INVALID_DATE', 400);
  }
  return value;
}

function descriptor(d, maximum = MAX_METADATA) {
  check(d && typeof d === 'object' && HEX.test(d.sha256) && positive(d.bytes) && d.bytes <= maximum);
  check(d.key === `${PREFIX}${d.sha256.slice(0,2)}/${d.sha256}.${d.codec || 'json'}`);
  return d;
}

function parse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ArchiveError('ARCHIVE_JSON_INVALID'); }
}

async function consume(body, maximum, signal) {
  if (body instanceof Uint8Array) {
    check(body.byteLength <= maximum, 'ARCHIVE_TOO_LARGE');
    return Buffer.from(body);
  }
  check(body && typeof body[Symbol.asyncIterator] === 'function', 'ARCHIVE_BODY_INVALID');
  let size = 0;
  const chunks = [];
  for await (const chunk of body) {
    signal.throwIfAborted();
    check(chunk instanceof Uint8Array, 'ARCHIVE_BODY_INVALID');
    size += chunk.byteLength;
    check(size <= maximum, 'ARCHIVE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

class MetadataCache {
  constructor(limit) { this.limit = limit; this.size = 0; this.entries = new Map(); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, bytes) {
    // Account conservatively for parsed objects as well as encoded bytes.
    const cost = bytes * 4;
    if (cost > this.limit) return;
    while (this.size + cost > this.limit) {
      const first = this.entries.keys().next().value;
      this.size -= this.entries.get(first).cost; this.entries.delete(first);
    }
    this.entries.set(key, { value, cost }); this.size += cost;
  }
}

/** No filesystem, SQLite, credentials, public URLs, writes, listing or fallback. */
export async function openArchiveRelease({ candidate, getObject, timeoutMs = 15000, cacheBytes = 16 * 1024 * 1024,
  maxConcurrentReads = 8 }) {
  check(typeof getObject === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000,
    'READER_CONFIGURATION_INVALID');
  check(Number.isSafeInteger(cacheBytes) && cacheBytes >= 0 && cacheBytes <= 64 * 1024 * 1024,
    'READER_CONFIGURATION_INVALID');
  check(Number.isSafeInteger(maxConcurrentReads) && maxConcurrentReads > 0 && maxConcurrentReads <= 32,
    'READER_CONFIGURATION_INVALID');
  descriptor(candidate);
  const cache = new MetadataCache(cacheBytes), pending = new Map();
  let activeReads = 0;

  async function fetchBytes(d, signal) {
    if (activeReads >= maxConcurrentReads) throw new ArchiveError('ARCHIVE_READER_BUSY');
    activeReads++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ArchiveError('ARCHIVE_TIMEOUT')), timeoutMs);
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) { clearTimeout(timer); activeReads--; throw signal.reason; }
    signal?.addEventListener('abort', abort, { once: true });
    const operation = (async () => {
      try {
        const response = await getObject(d.key, { signal: controller.signal, maxBytes: d.bytes });
        const raw = await consume(response?.body ?? response, d.bytes, controller.signal);
        check(raw.length === d.bytes && hash(raw) === d.sha256);
        return raw;
      } catch (e) {
        if (e instanceof ArchiveError || controller.signal.aborted) throw controller.signal.reason || e;
        // An object listed in the signed catalogue missing remotely is a broken
        // release, not a logical 404 and never a reason to try an older release.
        throw new ArchiveError('ARCHIVE_STORAGE_UNAVAILABLE');
      }
    })();
    try { return await waitFor(operation, controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); activeReads--; }
  }

  async function meta(d, validate, signal) {
    signal?.throwIfAborted();
    descriptor(d);
    let value = cache.get(d.key);
    if (value) { validate(value); return value; }
    let promise = pending.get(d.key);
    if (!promise) {
      // Each caller can abort its own wait without cancelling another caller.
      promise = (async () => {
        const parsed = parse(await fetchBytes(d));
        validate(parsed);
        cache.set(d.key, parsed, d.bytes);
        return parsed;
      })();
      pending.set(d.key, promise);
      promise.finally(() => pending.delete(d.key)).catch(() => {});
    }
    const parsed = await waitFor(promise, signal);
    validate(parsed);
    return parsed;
  }

  const release = parse(await fetchBytes(candidate));
  check(release.schema === 'bonzobyte.online-archive-release.v1' && HEX.test(release.release) &&
    HEX.test(release.inventorySha256) && isoDate(release.through) && positive(release.files) && positive(release.matches) &&
    release.shardAlgorithm === 'sha256-utf8-first-3-hex' && release.candidateOnly === true && release.activationAllowed === false);
  for (const group of [release.catalogues, release.routing?.id, release.routing?.tp]) {
    check(group && typeof group === 'object' && !Array.isArray(group) && Object.keys(group).length <= 4096);
    for (const [key, d] of Object.entries(group)) { check(SHARD.test(key) && positive(d.rows)); descriptor(d); }
  }
  check(Object.values(release.catalogues).reduce((n,d) => n + d.rows, 0) === release.files);
  descriptor(release.dailyDates);
  check(Array.isArray(release.reports) && release.reports.every(p => logicalPath(p)));

  async function lookup(logical, signal) {
    logicalPath(logical);
    const shard = shardOf(logical), d = own(release.catalogues, shard);
    if (!d) throw new ArchiveError('ARCHIVE_NOT_FOUND', 404);
    const catalogue = await meta(d, value => {
      check(value.schema === 'bonzobyte.online-catalogue.v1' && value.shard === shard &&
        Array.isArray(value.rows) && value.rows.length === d.rows);
      let previous = '';
      for (const row of value.rows) {
        check(Array.isArray(row) && row.length === 5);
        const [path, key, bytes, sha256, jsonSha] = row;
        logicalPath(path);
        check(path > previous && shardOf(path) === shard && HEX.test(jsonSha)); previous = path;
        descriptor({key, bytes, sha256, codec:path.endsWith('.br') ? 'br' : 'json'}, MAX_PAYLOAD);
      }
    }, signal);
    const row = catalogue.rows.find(r => r[0] === logical);
    if (!row) throw new ArchiveError('ARCHIVE_NOT_FOUND', 404);
    return row;
  }

  async function payload(logical, { signal, maxBytes = MAX_PAYLOAD } = {}) {
    check(positive(maxBytes) && maxBytes <= MAX_PAYLOAD, 'INVALID_READ_LIMIT');
    const [path, key, bytes, sha256, jsonSha] = await lookup(logical, signal);
    check(bytes <= maxBytes, 'ARCHIVE_TOO_LARGE');
    const raw = await fetchBytes({key, bytes, sha256}, signal);
    let decoded;
    try { decoded = path.endsWith('.br') ? await decompress(raw, { maxOutputLength: MAX_PAYLOAD }) : raw; }
    catch { throw new ArchiveError('ARCHIVE_DECOMPRESSION_FAILED'); }
    check(hash(decoded) === jsonSha, 'ARCHIVE_DECODED_HASH_MISMATCH');
    signal?.throwIfAborted();
    return { raw, decoded };
  }

  async function locate(kind, value, { signal } = {}) {
    if (!/^[1-9][0-9]*$/.test(String(value)) || !positive(Number(value))) throw new ArchiveError('INVALID_MATCH_ID', 400);
    const id = Number(value), shard = shardOf(id), d = own(release.routing[kind], shard);
    if (!d) return null;
    const routing = await meta(d, data => {
      check(data.schema === 'bonzobyte.online-match-routing.v1' && data.kind === kind && data.shard === shard &&
        Array.isArray(data.rows) && data.rows.length === d.rows);
      let previous = 0;
      for (const row of data.rows) {
        check(Array.isArray(row) && row.length === 4 && row.slice(0,3).every(positive) && row[0] > previous &&
          shardOf(row[0]) === shard && isoDate(row[3])); previous = row[0];
      }
    }, signal);
    const r = routing.rows.find(r => r[0] === id);
    return r ? { matchId:r[1], tp:r[2], day:r[3], alias:r[0] !== r[kind === 'id' ? 1 : 2] } : null;
  }

  const kinds = {daily:'daily',matches:'matches','player-details':'players/details',
    'players/lite':'players/lite','players/details':'players/details','players/matches':'players/matches','players/ts':'players/ts',
    'tournaments/lite':'tournaments/lite','tournaments/matches':'tournaments/matches'};
  async function read(kind, name, options) {
    if (!own(kinds, kind)) throw new ArchiveError('INVALID_ARCHIVE_KIND', 400);
    return (await payload(`${kinds[kind]}/${name}.br`, options)).raw;
  }
  async function index(kind, options) {
    if (!['players','tournaments'].includes(kind)) throw new ArchiveError('INVALID_INDEX', 400);
    const filename = kind === 'players' ? 'manifest.json' : 'manifest.tournaments.json';
    return parse((await payload(`${kind}/indexBuild/${filename}`, options)).decoded);
  }
  async function availableDates(options) {
    const d = release.dailyDates;
    const data = await meta(d, x => {
      check(x.schema === 'bonzobyte.online-dates.v1' && Array.isArray(x.dates) && x.dates.length === d.rows);
      check(x.dates.every((day,i) => isoDate(day) && (i === 0 || day > x.dates[i-1])));
    }, options?.signal);
    return [...data.dates];
  }
  return Object.freeze({
    releaseId:release.release, through:release.through,
    read, readRelative:async (path, options) => (await payload(path, options)).raw,
    readJson:async (path, options) => parse((await payload(path, options)).decoded),
    readVerified:payload, index, availableDates,
    locateMatchById:(id, options) => locate('id', id, options),
    locateMatchByTp:(tp, options) => locate('tp', tp, options),
    locateDate:async (tp, options) => (await locate('tp', tp, options))?.day ?? null,
    status:() => ({release:release.release, through:release.through, metadataCacheBytes:cache.size,
      metadataCacheLimit:cache.limit, pendingMetadata:pending.size, activeReads, maxConcurrentReads, localFallback:false}),
  });
}
