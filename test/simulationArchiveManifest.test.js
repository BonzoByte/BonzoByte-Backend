import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSimulationArchiveName } from '../utils/simulationArchiveManifest.js';

const validManifest = {
    schema: 'bonzobyte.prediction-simulation.manifest',
    schemaVersion: 1,
    report: {
        file: 'prediction-simulation.v1.aa59bf088225b6a5.json.br',
        schema: 'bonzobyte.prediction-simulation',
        schemaVersion: 1,
    },
};

test('accepts the versioned local simulation report contract', () => {
    const buffer = Buffer.from(JSON.stringify(validManifest));
    assert.equal(
        parseSimulationArchiveName(buffer),
        'prediction-simulation.v1.aa59bf088225b6a5.json.br'
    );
});

test('accepts a UTF-8 BOM on the manifest', () => {
    const buffer = Buffer.from(`\uFEFF${JSON.stringify(validManifest)}`);
    assert.equal(
        parseSimulationArchiveName(buffer),
        'prediction-simulation.v1.aa59bf088225b6a5.json.br'
    );
});

test('rejects traversal and unversioned report names', () => {
    for (const file of [
        '../prediction-simulation.json.br',
        'prediction-simulation.json.br',
        'prediction-simulation.v1.not-a-hash.json.br',
    ]) {
        const buffer = Buffer.from(JSON.stringify({
            ...validManifest,
            report: { ...validManifest.report, file },
        }));
        assert.throws(
            () => parseSimulationArchiveName(buffer),
            /invalid report/i
        );
    }
});

test('rejects incompatible manifest and report schema versions', () => {
    const manifestVersion = Buffer.from(JSON.stringify({
        ...validManifest,
        schemaVersion: 2,
    }));
    const reportVersion = Buffer.from(JSON.stringify({
        ...validManifest,
        report: { ...validManifest.report, schemaVersion: 2 },
    }));

    assert.throws(() => parseSimulationArchiveName(manifestVersion));
    assert.throws(() => parseSimulationArchiveName(reportVersion));
});
