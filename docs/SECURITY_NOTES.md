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
- Avatar uploads now route through a local avatar storage adapter and store `avatarKey` / `avatarUpdatedAt` alongside legacy `avatarUrl`, preparing for a later R2/CDN adapter.

## Resolved / Completed

- Resolved: Mongo URI / database connection values are no longer logged at startup (`0061853 Stop logging Mongo connection string`).
- Resolved: The duplicate-email registration lookup no longer selects the password field (`ec836f3 Avoid selecting password during registration lookup`).
- Resolved: Backend registration now validates email format, password length, and optional nickname length (`0054c2d Add backend registration input validation`).
- Resolved: Protected access JWTs now carry and enforce token version claims (`377d1f5 Enforce token version for protected JWTs`).
- Resolved: Active optional auth for public archive routes now loads user context only for valid versioned tokens (`de552f7 Load user context in optional auth`).
- Resolved: The unused optional auth export was removed from the protected auth middleware module.
- Resolved: Auth development/debug routes are fail-closed and require an explicit development bypass flag outside production.
- Resolved: Archive debug endpoints are fail-closed and require the shared explicit development bypass flag outside production.
- Resolved: Public archive status now returns only a lightweight payload, while verbose archive diagnostics moved to a gated debug status endpoint.
- Resolved: Password reset tokens are stored hashed, forgot-password responses are generic, and reset links no longer include email addresses.
- Resolved: OAuth success transport now sends the access token in the URL fragment instead of the query string.
- Resolved: Angular access tokens are stored in sessionStorage, and legacy localStorage auth keys are cleared.
- Resolved: Angular clears stale sessions on first-party authorized API `401` responses, while public auth flows and `403` authorization responses remain feature-level handling.
- Resolved: Avatar uploads now use a non-public temp directory, server-side image decode/re-encode cleanup, and the legacy auth update route no longer accepts direct avatar file uploads.

## Known Risks And Follow-Up Items

- Low/Accepted: Password reset links still carry a raw one-time token in the URL fragment so the browser can submit it; treat reset links as sensitive.
- Unknown: `uploads/avatars/` currently contains tracked user-upload/avatar assets. This is accepted as current known project state, but it should not be treated as the long-term production storage model. Long-term, user-uploaded avatars should move to object storage/CDN, with the backend storing references, URLs, or metadata rather than binary uploads in git. Do not refactor avatar upload/storage casually because it affects frontend profile UI, backend upload middleware, stored user avatar paths, and deployed/static asset behavior.
- Follow-up: Add the R2/S3 avatar storage adapter and then remove tracked avatar uploads from git in a separate cleanup commit.

## Recommended Order

1. Review avatar storage architecture and move user-uploaded avatars out of git-tracked assets.

## Do Not Do Blindly

- Do not change JWT payload or token expiry without frontend/session impact review.
- Do not change OAuth flow without frontend callback review.
- Do not change reset token behavior without migration/user-flow review.
- Do not rely on frontend validation as a security boundary.
- Do not commit secrets, sample real tokens, Mongo URI values, or password hashes.
