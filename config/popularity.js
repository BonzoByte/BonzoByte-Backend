export const POPULARITY_ENVIRONMENTS = ['development', 'sandbox', 'production'];

export function popularityConfig(settings = process.env) {
    const environment = settings.POPULARITY_ENVIRONMENT || 'development';
    const developmentDefault = environment === 'development'
        && ['development', 'test'].includes(settings.NODE_ENV || 'development');
    const enabled = settings.POPULARITY_ENABLED || (developmentDefault ? 'true' : 'false');
    if (!POPULARITY_ENVIRONMENTS.includes(environment) || !['true', 'false'].includes(enabled))
        throw new Error('Invalid popularity configuration');
    if (environment === 'production' && (settings.NODE_ENV !== 'production'
        || settings.BILLING_LAB_ENABLED === 'true' || settings.ARCHIVES_ONLY === 'true'))
        throw new Error('Production popularity requires an explicit production runtime, outside isolated modes');
    return { environment, enabled: enabled === 'true',
        dailyCollection: `popularity_${environment}_daily`, dedupeCollection: `popularity_${environment}_dedupe` };
}
