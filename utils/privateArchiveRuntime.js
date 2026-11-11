import { ArchiveError, openArchiveRelease } from './private-archive-reader/reader.mjs';
import { createS3Transport } from './private-archive-reader/s3-transport.mjs';

export const PRIVATE_ARCHIVE_ENDPOINT = 'https://6cd78d11a9b52601ce8ffce8f32ae403.r2.cloudflarestorage.com';
export const PRIVATE_ARCHIVE_BUCKET = 'bb-live-archives';
const SHA256 = /^[a-f0-9]{64}$/;

// Approved ArchivePublisher source SHA-256s; vendored files are byte-for-byte copies.
export const PRIVATE_READER_SOURCE_SHA256 = Object.freeze({
    'reader.mjs': 'ceceefa1c904d1164c6967a86de6ffadb9052434017721c9b1648faadb8df227',
    's3-transport.mjs': '04047922fcbfd4bd6c85861554c765e68f0b150c09796f4ec00df458c10186a1',
    'archive-handlers.mjs': '507b68f8c2fda60eb4c9896b160dc01cb026d9d5e1c7ba6f05465622c6806c9e',
});

export function privateArchiveConfig(settings, { requireCredentials = true } = {}) {
    const sha256 = settings.BONZOBYTE_ARCHIVE_CANDIDATE_SHA256;
    const key = settings.BONZOBYTE_ARCHIVE_CANDIDATE_KEY;
    const bytesText = String(settings.BONZOBYTE_ARCHIVE_CANDIDATE_BYTES ?? '');
    const bytes = Number(bytesText);
    const accessKeyId = settings.BONZOBYTE_ARCHIVE_READ_KEY_ID;
    const secretAccessKey = settings.BONZOBYTE_ARCHIVE_READ_SECRET;
    if (settings.ARCHIVES_SOURCE !== 'publisher' || settings.APP_STAGE !== 'beta'
        || !SHA256.test(sha256 || '')
        || key !== `publisher-staging-v1/objects/${sha256?.slice(0, 2)}/${sha256}.json`
        || !/^[1-9][0-9]*$/.test(bytesText) || !Number.isSafeInteger(bytes) || bytes > 8 * 1024 * 1024
        || settings.BONZOBYTE_ARCHIVE_READ_ENDPOINT !== PRIVATE_ARCHIVE_ENDPOINT
        || (requireCredentials && (![accessKeyId, secretAccessKey].every(v => typeof v === 'string' && v.trim())))) {
        throw new ArchiveError('PRIVATE_ARCHIVE_CONFIGURATION_INVALID');
    }
    return {
        candidate: { key, sha256, bytes },
        client: {
            endpoint: PRIVATE_ARCHIVE_ENDPOINT, region: 'auto', forcePathStyle: true,
            credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1,
            requestHandler: { connectionTimeout: 10000, requestTimeout: 15000 },
            requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
        },
    };
}

/** One pinned release per runtime. No env loader, local reader, public URL or listing. */
export function createPrivateArchiveRuntime({ settings = process.env, getObject, client,
    GetObjectCommand, createClient, openReader = openArchiveRelease } = {}) {
    let opening;
    async function initialize() {
        const config = privateArchiveConfig(settings, { requireCredentials: !getObject && !client });
        let ownedClient;
        try {
            let transport = getObject;
            if (!transport) {
                const sdk = await import('@aws-sdk/client-s3');
                const storageClient = client ?? (ownedClient = createClient
                    ? await createClient(config.client) : new sdk.S3Client(config.client));
                transport = createS3Transport({ enabled: true, client: storageClient,
                    bucket: PRIVATE_ARCHIVE_BUCKET, GetObjectCommand: GetObjectCommand ?? sdk.GetObjectCommand });
            }
            // private-day-preview is an intentional candidate scope, not a public activation.
            // The approved reader checks candidateOnly=true and activationAllowed=false.
            return await openReader({ candidate: config.candidate, getObject: transport });
        } catch (error) {
            ownedClient?.destroy?.();
            throw error;
        }
    }
    function getReader() {
        if (!opening) {
            opening = Promise.resolve().then(initialize).catch(error => {
                opening = undefined; // Coalesced callers fail together; the next request retries.
                throw error;
            });
        }
        return opening;
    }
    async function readBuffer(kind, name, options) {
        try { return await (await getReader()).read(kind, name, options); }
        catch (error) {
            // The existing favourites resolver recognizes ENOENT, not ArchiveError.
            // Only logical non-members map to missing: network/integrity errors never do.
            if (error instanceof ArchiveError && error.status === 404) {
                throw Object.assign(new Error('ARCHIVE_NOT_FOUND', { cause: error }), { code: 'ENOENT', status: 404 });
            }
            throw error;
        }
    }
    return Object.freeze({
        getReader, readBuffer,
        async locateMatchById(id, options) {
            const found = await (await getReader()).locateMatchById(id, options);
            return found ? { matchId: found.matchId, matchTPId: found.tp } : null;
        },
        async locateDate(tp, options) { return (await getReader()).locateDate(tp, options); },
    });
}

// Importing this module never validates env, constructs a client or starts a read.
export const privateArchiveRuntime = createPrivateArchiveRuntime();
export const getPrivateArchiveReader = privateArchiveRuntime.getReader;
export const readBuffer = privateArchiveRuntime.readBuffer;
export const readArchiveBuffer = readBuffer;
export const locateMatchById = privateArchiveRuntime.locateMatchById;
export const locateDate = privateArchiveRuntime.locateDate;
// Explicit names used by the separate host-provider integration.
export const readPrivateArchiveBuffer = readBuffer;
export const locatePrivateArchiveDate = locateDate;
export const locatePrivateMatchById = locateMatchById;
