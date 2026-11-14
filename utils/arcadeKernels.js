import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Only locally shipped, hash-checked kernels are allowed. No client paths or downloads.
export const PREVIOUS_ARCADE_VERSION = '69e61a041a221b80e2c2fbcabeae9d130aa96e5e35860274870c4d579e7a5e9d';
export const CHARGED_ARCADE_VERSION = '514d599410b0ca24477f5f19747ed36dede1dd66e2f1ffda733f359600733d82';
const kernels = new Map();
function register(folder, expectedVersion) {
    const root = new URL(folder, import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
    if (manifest.schema !== 'bonzobyte.arcade-kernel.v1' || !/^[a-f0-9]{64}$/.test(manifest.version) ||
        (expectedVersion && manifest.version !== expectedVersion)) throw Error('Invalid arcade kernel manifest');
    const expectedNames = ['tennis-3d-engine.cjs','tennis-replay.cjs','tennis-scoring.cjs','tennis-skill.cjs'];
    if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expectedNames)) throw Error('Incomplete arcade kernel');
    for (const [name, hash] of Object.entries(manifest.files)) {
        if (createHash('sha256').update(readFileSync(new URL(name, root))).digest('hex') !== hash) throw Error('Arcade kernel checksum failed');
    }
    kernels.set(manifest.version, root);
    return manifest.version;
}
export const CURRENT_ARCADE_VERSION = register('./arcade-engine/');
register(`./arcade-engine-${PREVIOUS_ARCADE_VERSION}/`, PREVIOUS_ARCADE_VERSION);
register(`./arcade-engine-${CHARGED_ARCADE_VERSION}/`, CHARGED_ARCADE_VERSION);
export function arcadeKernel(version) { return kernels.get(version) ?? null; }
