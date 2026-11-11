import 'dotenv/config';
import { z } from 'zod';
import { assertBillingLabEnvironment } from '../utils/billingLabSafety.js';
import { emailAllowlist, exactOrigins } from '../utils/accessPolicy.js';

assertBillingLabEnvironment();

const archivesOnly = String(process.env.ARCHIVES_ONLY || '').toLowerCase() === 'true';

const asOptionalUrl = z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().optional()
);

const asOptionalString = z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional()
);

const asStringDefault = (defaultValue) => z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().default(defaultValue)
);

const asStorageDriver = z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toLowerCase() : undefined),
    z.enum(['local', 'r2']).default('local')
);

const Env = z.object({
    FRONTEND_URL: z.string().url().default('https://bonzo-byte-frontend.vercel.app'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_STAGE: z.enum(['development', 'beta']).default('development'),
    BETA_PUBLIC_ORIGIN: asOptionalUrl,
    BETA_TESTERS: z.string().default(''),
    BETA_CODE_SECRET: asOptionalString,
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
    PORT: z.coerce.number().default(5000),

    MONGO_URI: archivesOnly ? z.string().optional() : z.string().min(1),
    MONGO_DB: asOptionalString,
    JWT_SECRET: archivesOnly ? z.string().optional() : z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('1d'),
    JWT_VERIFICATION_EXPIRES_IN: z.string().default('1h'),
    DETAILS_LOCK_TEST_MODE: z.string().optional(),
    NOW_OVERRIDE_ISO: z.string().optional(),
    DEV_BYPASS_VERIFY: asOptionalString,
    EMAIL_DISABLED: asOptionalString,
    REFERRALS_ENABLED: z.enum(['true', 'false']).default('false'),
    PAYPAL_SANDBOX_ENABLED: z.enum(['true', 'false']).default('false'),
    PAYPAL_MEMBERSHIP_ENABLED: z.enum(['true', 'false']).default('false'),
    BILLING_EMAIL_ENABLED: z.enum(['true', 'false']).default('false'),
    PAYPAL_CLIENT_ID: asOptionalString,
    PAYPAL_CLIENT_SECRET: asOptionalString,
    PAYPAL_SANDBOX_WEBHOOK_ID: asOptionalString,

    DETAILS_LOCK_HOURS: z.coerce
        .number()
        .min(0)
        .max(24)
        .default(1)
        .refine((n) => Number.isInteger(n), { message: 'DETAILS_LOCK_HOURS must be an integer.' }),

    EMAIL_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),
    RESEND_API_KEY: asOptionalString,
    EMAIL_FROM: asOptionalString,
    EMAIL_FROM_NAME: asOptionalString,
    EMAIL_ROUTING_ENABLED: z.enum(['true', 'false']).default('false'),
    EMAIL_SENDER_DOMAIN: asOptionalString,
    EMAIL_REPLY_TO: asOptionalString,
    SUPPORT_EMAIL: asOptionalString,
    CONTACT_TO: asOptionalString,

    EMAIL_USER: z.string().email().optional(),
    EMAIL_PASS: z.string().optional(),
    SMTP_HOST: asOptionalString,
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: asOptionalUrl,
    FACEBOOK_CLIENT_ID: z.string().optional(),
    FACEBOOK_CLIENT_SECRET: z.string().optional(),
    FACEBOOK_CALLBACK_URL: asOptionalUrl,

    CORS_ORIGINS: z.string().default('https://bonzo-byte-frontend.vercel.app'),
    DNS_SERVERS: asOptionalString,
    BASE_URL: z.string().url().default('https://bonzobyte-backend.onrender.com'),

    ARCHIVES_ONLY: z.string().optional(),

    // Default to remote storage; local mode must be explicitly enabled in .env.
    ARCHIVES_SOURCE: z.enum(['remote', 'local', 'pending']).default('remote'),

    ARCHIVES_BASE_URL: asOptionalUrl,
    BROTLI_DAILY_DIR: asOptionalString,
    BROTLI_MATCH_DETAILS_DIR: asOptionalString,
    BROTLI_PLAYERS_INDEX_DIR: asOptionalString,
    BROTLI_PLAYERS_DETAILS_DIR: asOptionalString,
    BROTLI_PLAYERS_MATCHES_DIR: asOptionalString,
    BROTLI_TS_DIR: asOptionalString,
    BROTLI_TOURNAMENTS_MATCHES_DIR: asOptionalString,
    BROTLI_TOURNAMENTS_INDEX_DIR: asOptionalString,
    BROTLI_ANALYTICS_DIR: asOptionalString,
    R2_BUCKET: z.string().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),

    AVATAR_STORAGE_DRIVER: asStorageDriver,
    AVATAR_PUBLIC_BASE_URL: asOptionalUrl,
    AVATAR_R2_BUCKET: asOptionalString,
    AVATAR_R2_ACCOUNT_ID: asOptionalString,
    AVATAR_R2_ENDPOINT: asOptionalUrl,
    AVATAR_R2_ACCESS_KEY_ID: asOptionalString,
    AVATAR_R2_SECRET_ACCESS_KEY: asOptionalString,
    AVATAR_STORAGE_PREFIX: asStringDefault('avatars'),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
    console.error(parsed.error.format());
    throw new Error('Invalid environment variables');
}

export const env = parsed.data;
export const corsAllowlist = exactOrigins(env.CORS_ORIGINS);
export const betaTesters = emailAllowlist(env.BETA_TESTERS);
export const betaEnabled = env.APP_STAGE === 'beta';
if (env.NODE_ENV === 'production' && !betaEnabled)
    throw new Error('Online production builds currently require APP_STAGE=beta; public launch is not enabled.');
if (betaEnabled) {
    const origin = new URL(env.BETA_PUBLIC_ORIGIN || 'http://invalid');
    if (env.NODE_ENV !== 'production' || !/^[A-Za-z0-9_-]+_Beta$/.test(env.MONGO_DB || '')
        || origin.protocol !== 'https:' || origin.origin !== env.BETA_PUBLIC_ORIGIN || !corsAllowlist.includes(origin.origin)
        || env.FRONTEND_URL !== origin.origin || !env.BETA_CODE_SECRET || env.BETA_CODE_SECRET.length < 32
        || env.BETA_CODE_SECRET === env.JWT_SECRET || archivesOnly || process.env.BILLING_LAB_ENABLED === 'true'
        || env.DEV_BYPASS_VERIFY === '1')
        throw new Error('Beta requires NODE_ENV=production, a separate explicit MONGO_DB ending in _Beta, an exact HTTPS origin, matching FRONTEND_URL/CORS, a separate 32+ character code secret and normal verified auth.');
}
export const frontendUrl = env.FRONTEND_URL;
export const ARCHIVES_NOW_ISO = '2016-01-04T12:00:00';
