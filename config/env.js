const Env = z.object({
    FRONTEND_URL: z.string().url().default('http://localhost:4200'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(5000),

    MONGO_URI: archivesOnly ? z.string().optional() : z.string().min(1),
    JWT_SECRET: archivesOnly ? z.string().optional() : z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('1d'),
    JWT_VERIFICATION_EXPIRES_IN: z.string().default('1h'),

    DETAILS_LOCK_HOURS: z.coerce.number().min(0).max(24).default(2).refine(Number.isInteger, {
        message: 'DETAILS_LOCK_HOURS must be an integer.',
    }),

    EMAIL_USER: z.string().email().optional(),
    EMAIL_PASS: z.string().optional(),

    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: asOptionalUrl,

    FACEBOOK_CLIENT_ID: z.string().optional(),
    FACEBOOK_CLIENT_SECRET: z.string().optional(),
    FACEBOOK_CALLBACK_URL: asOptionalUrl,

    CORS_ORIGINS: z.string().default('http://localhost:4200'),
    BASE_URL: z.string().url().default('http://localhost:5000'),

    ARCHIVES_ONLY: z.string().optional(),
    ARCHIVES_SOURCE: z.enum(['remote', 'local']).default('remote'),

    ARCHIVES_BASE_URL: asOptionalUrl,
    R2_BUCKET: z.string().optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
});  