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

## Resolved / Completed

- Resolved: Mongo URI / database connection values are no longer logged at startup (`0061853 Stop logging Mongo connection string`).
- Resolved: The duplicate-email registration lookup no longer selects the password field (`ec836f3 Avoid selecting password during registration lookup`).
- Resolved: Backend registration now validates email format, password length, and optional nickname length (`0054c2d Add backend registration input validation`).
- Resolved: Protected access JWTs now carry and enforce token version claims (`377d1f5 Enforce token version for protected JWTs`).
- Resolved: Active optional auth for public archive routes now loads user context only for valid versioned tokens (`de552f7 Load user context in optional auth`).
- Resolved: The unused optional auth export was removed from the protected auth middleware module.
- Resolved: Auth development/debug routes are fail-closed and require an explicit development bypass flag outside production.
- Resolved: Archive debug endpoints are fail-closed and require the shared explicit development bypass flag outside production.

## Known Risks And Follow-Up Items

- High: Password reset tokens appear to be stored as plaintext fields and sent through URL query params; consider storing hashed reset tokens and reviewing reset-link transport.
- High/Medium: OAuth success redirect appears to pass JWT through the query string; query tokens can leak through browser history, logs, analytics, referrers, or screenshots.
- Medium: Forgot/reset flows may reveal whether an email exists; consider generic responses.
- Medium/Unknown: `/api/archives/status` exposes archive/storage diagnostic metadata and should be classified separately as either a public health/status endpoint or an admin/dev diagnostic endpoint.
- Unknown: Avatar upload is auth-adjacent and deserves a later focused review.
- Unknown: `uploads/avatars/` currently contains tracked user-upload/avatar assets. This is accepted as current known project state, but it should not be treated as the long-term production storage model. Long-term, user-uploaded avatars should move to object storage/CDN, with the backend storing references, URLs, or metadata rather than binary uploads in git. Do not refactor avatar upload/storage casually because it affects frontend profile UI, backend upload middleware, stored user avatar paths, and deployed/static asset behavior.

## Recommended Order

1. Review reset token hashing and reset response enumeration.
2. Review OAuth token transport.
3. Classify `/api/archives/status` as public health/status or admin/dev diagnostic.
4. Review Angular token storage and session handling.
5. Review avatar upload security.
6. Review avatar storage architecture and move user-uploaded avatars out of git-tracked assets.

## Do Not Do Blindly

- Do not change JWT payload or token expiry without frontend/session impact review.
- Do not change OAuth flow without frontend callback review.
- Do not change reset token behavior without migration/user-flow review.
- Do not rely on frontend validation as a security boundary.
- Do not commit secrets, sample real tokens, Mongo URI values, or password hashes.
