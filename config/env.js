import 'dotenv/config';
import { z } from 'zod';

const archivesOnly = String(process.env.ARCHIVES_ONLY || '').toLowerCase() === 'true';

const isDev = (process.env.NODE_ENV || 'development') === 'development';

const Env = z.object({
    FRONTEND_URL: z.string().url().default('http://localhost:4200'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(5000),

    MONGO_URI: archivesOnly ? z.string().optional() : z.string().min(1),
    JWT_SECRET: archivesOnly ? z.string().optional() : z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('1d'),
    JWT_VERIFICATION_EXPIRES_IN: z.string().default('1h'),

    EMAIL_USER: z.string().email().optional(),
    EMAIL_PASS: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.string().url().optional(),
    FACEBOOK_CLIENT_ID: z.string().optional(),
    FACEBOOK_CLIENT_SECRET: z.string().optional(),
    FACEBOOK_CALLBACK_URL: z.string().url().optional(),

    CORS_ORIGINS: z.string().default('http://localhost:4200'),
    BASE_URL: z.string().url().default('http://localhost:5000'),

    ARCHIVES_ONLY: z.string().optional(),

    // ✅ default: dev => local, inače remote
    ARCHIVES_SOURCE: z.enum(['remote', 'local']).default(isDev ? 'local' : 'remote'),
    ARCHIVES_BASE_URL: z.string().url().optional(),
    R2_BUCKET: z.string().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid ENV:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const env = parsed.data;
export const corsAllowlist = env.CORS_ORIGINS.split(',').map(s => s.trim());
export const frontendUrl = env.FRONTEND_URL;