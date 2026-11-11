/** Local recovery adapters are never resolved or imported by the hosted backend. */
export async function loadLocalArchiveRuntime({ settings = process.env, importer = path => import(path) } = {}) {
    const keys = ['BONZOBYTE_RECOVERY_OVERLAY', 'BONZOBYTE_REVIEWED_ARCHIVES',
        'BONZOBYTE_REVIEWED_REPORTS', 'BONZOBYTE_REVIEWED_LOCAL_RELEASE'];
    const empty = { localRelease: null, reviewedConfig: undefined, recoveryReader: null, reviewedReports: null };
    if (!keys.some(key => settings[key])) return empty;
    if (settings.NODE_ENV !== 'development' || settings.APP_STAGE !== 'development' || settings.ARCHIVES_SOURCE !== 'local')
        throw new Error('Recovery archives are permitted only in local development.');
    const { resolveReviewedLocalRelease } = await importer('../../../ReviewedLocalRelease20261104.mjs');
    const localRelease = await resolveReviewedLocalRelease(settings);
    const reviewedConfig = localRelease?.archiveConfigPath || settings.BONZOBYTE_REVIEWED_ARCHIVES;
    let recoveryReader = null;
    if (reviewedConfig) {
        const { openReviewedArchiveReader } = await importer('../../../ReviewedRallyArchives20261103.mjs');
        recoveryReader = await openReviewedArchiveReader({ configPath: reviewedConfig });
    } else if (settings.BONZOBYTE_RECOVERY_OVERLAY) {
        const { openRecoveryArchiveReader } = await importer('../../../RecoveryArchiveReader.mjs');
        recoveryReader = await openRecoveryArchiveReader({ root: settings.BONZOBYTE_ARCHIVES_ROOT,
            overlayConfig: settings.BONZOBYTE_RECOVERY_OVERLAY, oddsConfig: settings.BONZOBYTE_RECOVERY_ODDS,
            assembly: { path: 'C:/BonzoByteRuntime/_runtime/canonical-archive-reviewed-20261018-03/assembly.sqlite',
                sha256: 'eb7902dadf2caa17d5c9ce3d3e380942da70ab1730a3afe1305f76428c222bec' } });
    }
    const reportConfig = localRelease?.reportConfigPath || settings.BONZOBYTE_REVIEWED_REPORTS;
    let reviewedReports = null;
    if (reportConfig) {
        const { openReviewedDerivedReports } = await importer('../../../ReviewedDerivedReports20261103.mjs');
        reviewedReports = await openReviewedDerivedReports({ configPath: reportConfig, archiveConfigPath: reviewedConfig });
    }
    return { localRelease, reviewedConfig, recoveryReader, reviewedReports };
}
