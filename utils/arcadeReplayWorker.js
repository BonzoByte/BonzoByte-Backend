import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { arcadeKernel, PREVIOUS_ARCADE_VERSION } from './arcadeKernels.js';
const require = createRequire(import.meta.url);
try {
    // The preceding API process did not send a version. Preserve its in-flight sessions during activation.
    const root = arcadeKernel(workerData.config.engineVersion ?? PREVIOUS_ARCADE_VERSION);
    if (!root) throw Error('Unknown arcade version');
    const { replayArcade } = require(fileURLToPath(new URL('tennis-replay.cjs', root)));
    parentPort.postMessage({ ok: true, result: replayArcade(Buffer.from(workerData.replay, 'base64'), workerData.config) });
} catch { parentPort.postMessage({ ok: false }); }
