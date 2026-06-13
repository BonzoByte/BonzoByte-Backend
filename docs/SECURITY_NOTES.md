# Security Notes

## Scope

These notes are based on read-only source review of the Node.js backend auth and user flow.
No runtime validation was performed.
No secrets, tokens, password hashes, connection strings, Mongo URI values, or concrete local config values should be copied into this document.

## Current Good Practices

- The user password field is excluded by default from normal Mongoose reads.
- bcrypt password hashing is used through the user model save hook.
- Login explicitly selects the password field only for credential comparison.
- Bearer JWT middleware exists for protected API routes.
- Core auth responses generally sanitize password fields from user payloads.
- Helmet, CORS allow-listing, global rate limiting, and auth route rate limiting exist.
- Admin data mutations generally use protected/admin middleware.
- New protected access JWTs include a token version claim, and the protected middleware rejects missing or mismatched token versions. Because the project has no real users yet, legacy access tokens without the version claim are intentionally not tolerated.
- Active optional auth for public archive routes validates token versions and loads user context for valid tokens; missing, invalid, stale, or mismatched optional tokens continue anonymously.

## Known Risks And Follow-Up Items

- Critical: Mongo URI / database connection values appear to be logged at startup; logs must not expose database credentials or connection strings.
- High: Password reset tokens appear to be stored as plaintext fields and sent through URL query params; consider storing hashed reset tokens and reviewing reset-link transport.
- High/Medium: OAuth success redirect appears to pass JWT through the query string; query tokens can leak through browser history, logs, analytics, referrers, or screenshots.
- Medium: A development email verification route exists and is gated by environment / non-production logic; production exposure should be verified.
- Medium: Backend register/login validation appears weaker than frontend validation; the backend must enforce its own password and input policy.
- Medium: Forgot/reset flows may reveal whether an email exists; consider generic responses.
- Low/Unknown: A second optional auth export still exists in the protected auth middleware module; review or remove it later to avoid divergent optional-auth behavior.
- Low/Medium: Duplicate-email register check appears to select the password field unnecessarily.
- Low/Unknown: Optional auth middleware has more than one implementation; behavior should be reviewed for consistency.
- Unknown: Avatar upload is auth-adjacent and deserves a later focused review.
- Unknown: `uploads/avatars/` currently contains tracked user-upload/avatar assets. This is accepted as current known project state, but it should not be treated as the long-term production storage model. Long-term, user-uploaded avatars should move to object storage/CDN, with the backend storing references, URLs, or metadata rather than binary uploads in git. Do not refactor avatar upload/storage casually because it affects frontend profile UI, backend upload middleware, stored user avatar paths, and deployed/static asset behavior.

## Recommended Order

1. Remove or mask Mongo URI logging.
2. Remove unnecessary password selection in register duplicate check.
3. Add backend-side password and input validation.
4. Review unused optional-auth export in the protected auth middleware module.
5. Review reset token hashing and reset response enumeration.
6. Review OAuth token transport.
7. Review development-only routes and production gates.
8. Review avatar upload security.
9. Review avatar storage architecture and move user-uploaded avatars out of git-tracked assets.

## Do Not Do Blindly

- Do not change JWT payload or token expiry without frontend/session impact review.
- Do not change OAuth flow without frontend callback review.
- Do not change reset token behavior without migration/user-flow review.
- Do not rely on frontend validation as a security boundary.
- Do not commit secrets, sample real tokens, Mongo URI values, or password hashes.
