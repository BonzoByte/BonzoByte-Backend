import { fileURLToPath } from 'node:url';

export const BETA_ARCADE_CATALOG_SHA = '398181669d39815505816855b9c62e978e19d1f3a5a89e92df29bf2e656d9cb6';

// The opt-in beta uses a shipped, reviewed catalogue, never a local path or URL.
// It does not enable prizes or change any tennis ratings/models.
export function arcadeRuntimeSettings(settings = process.env) {
    const local = settings.NODE_ENV === 'development' && settings.APP_STAGE !== 'production';
    const beta = settings.NODE_ENV === 'production' && settings.APP_STAGE === 'beta'
        && settings.MONGO_DB === 'BonzoByte_Beta' && settings.ARCADE_BETA_ENABLED === 'true';
    return {
        enabled: local || beta,
        beta,
        file: beta ? fileURLToPath(new URL('../data/beta-arcade-20261114.json', import.meta.url)) : settings.BONZOBYTE_ARCADE_CATALOG,
        digest: beta ? BETA_ARCADE_CATALOG_SHA : settings.BONZOBYTE_ARCADE_CATALOG_SHA,
    };
}
