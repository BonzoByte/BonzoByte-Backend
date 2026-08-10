const simulationArchiveNamePattern =
    /^prediction-simulation\.v4\.[0-9a-f]{16}\.json\.br$/i;

export function parseSimulationArchiveName(manifestBuffer) {
    const manifestText = manifestBuffer.toString('utf8').replace(/^\uFEFF/, '');
    const manifest = JSON.parse(manifestText);
    const fileName = String(manifest?.report?.file || '').trim();

    if (
        manifest?.schema !== 'bonzobyte.prediction-simulation.manifest' ||
        manifest?.schemaVersion !== 4 ||
        manifest?.report?.schema !== 'bonzobyte.prediction-simulation' ||
        manifest?.report?.schemaVersion !== 4 ||
        !simulationArchiveNamePattern.test(fileName)
    ) {
        const err = new Error(
            'Prediction simulation manifest contains an invalid report.'
        );
        err.statusCode = 500;
        throw err;
    }

    return fileName;
}
