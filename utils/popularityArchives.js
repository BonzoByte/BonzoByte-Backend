import { brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { canonicalTPId } from './popularity.js';

const decompress = promisify(brotliDecompress);
export function createPopularityArchiveReader(readBuffer) {
    return async (kind, id) => {
        if (!canonicalTPId(id) || !['match', 'player'].includes(kind)) return null;
        try {
            const compressed = await readBuffer(kind === 'match' ? 'matches' : 'player-details', String(id),
                { signal: AbortSignal.timeout(5000), maxBytes: 1024 * 1024 });
            if (compressed.length > 1024 * 1024) throw new Error('Archive exceeds read limit');
            const bytes = await decompress(compressed, { maxOutputLength: 4 * 1024 * 1024 });
            return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        } catch (error) {
            if (error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null;
            // Corruption, permissions, timeouts and outages are NOT 'not found'.
            throw error;
        }
    };
}
