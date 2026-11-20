# Private site audience — local review, not activated

This optional first-party feature reuses Express, MongoDB, the existing JWT
identity and Resend mail transport. It does not replace sign-in, grant admin
roles, change billing, train models or select archive releases.

## Boundaries

- Private report: `/site-insights` in Angular; `/api/site-insights/summary` and
  `/notifications` require a verified account with either approved owner email.
  `isAdmin` alone is not an alternative permission. Owner emails are not sent in
  report payloads or compiled into the frontend.
- View collection requires a fresh separate consent purpose, the exact production
  origin, valid random identifiers and a named section from a fixed allowlist.
  Localhost and Vercel preview origins are denied. Known automation is excluded.
- The two owner accounts and development fixtures are excluded. A successful
  internal identity check remembers a browser-local exclusion after logout.
  Manual exclusion is available in privacy settings; it grants no permissions.
- Invalid/stale bearer tokens do not fall back to anonymous recording.
- Do not equate page views, estimated browsers, signed-in activity, account totals
  or hosting HTTP requests. Account totals include pending account-closure records;
  external active-account counts exclude those records and internal/test accounts.
- Visits are pseudonymous, not claimed anonymous. Random browser IDs last at most
  30 days; server visit records have a 32-day TTL. URL parameters, full URLs,
  email addresses, names, full IPs and fingerprints are not stored by this feature.
  TTL deletion may be delayed by the database. Summary queries also filter expiry.
- View deduplication is bounded to 1,000 accepted distinct events per browser/day.
  Raw summaries are bounded to 50,000 visit/registration records per request;
  larger inputs return an unavailable report rather than fabricated totals.
- Withdrawal stops recording and requests removal of that browser's rows. Failed
  removal keeps a limited pending-removal identifier to retry, never to resume
  tracking. Removal still works with collection disabled while the database and
  retained hash secret are available; an unavailable removal is never reported
  as successful. Account erasure removes member hashes from visits and the account
  link from signup notices; pending notice mail is suppressed.

## Registration notices

Persistent reconciliation runs at most once per minute, at most 20 new accounts
per pass, outside the registration/login response path. Only verified external
accounts created since first activation are admitted. The displayed time is the
first observation time, not an exact historical verification timestamp.

The observation marker on the user and unique notice are committed together.
Repeated logins, resend requests, restarts and notice TTL expiry cannot recreate
the same signup notification. Notices last 90 days. A currently sending notice
has a bounded lease considered by account erasure.

Owner mail is optional and uses the existing Resend transport and an event-bound
idempotency key. The chosen recipient is `bonzobyte@gmail.com`. Messages contain
only observation time, signup method and the private report URL — no new user's
name/email. Retry at most five times and only within 20 hours, shorter than the
provider's idempotency window. Ambiguous delivery becomes manual review; do not
fall back to another provider. Test transports never send real mail.

## Activation — separate approval/release required

Default is OFF. Do not change the public archive candidate, Rally, existing Google
analytics flag, payments or account permissions to activate this feature.

Server variables (no secret values in this document):

```
SITE_INSIGHTS_ENABLED=true
SITE_INSIGHTS_SECRET=<new independent random secret, at least 32 characters>
SITE_INSIGHTS_EMAIL_ENABLED=true
SITE_INSIGHTS_NOTIFY_TO=bonzobyte@gmail.com
```

Only the exact existing production configuration for `https://bonzobyte.com` and
`BonzoByte_Beta` is admitted. The hash secret must differ from JWT/beta secrets.
Retain the same hash secret while visit rows exist (including when disabling
recording); account erasure needs it to unlink member hashes. Do not rotate it
without a separately reviewed cleanup/retention procedure.

The new beta frontend build requests a new privacy decision. Google Analytics
remains disabled. Release the compatible backend, inspect initialization/access,
then release the reviewed frontend and verify all real-domain consent/exclusion
and authorization paths. No production variables were changed during local work.

## Evidence and local review

Main-workspace evidence: `_runtime/site-insights-20261120-01/`.
Mongo tests create only a unique guarded `BonzoByte_Insights_Test_*` database and
remove it afterward; they never write to `BonzoByte_Beta`. Browser tests use the
actual compiled Angular app, API router, JWT verifier and real isolated Mongo
store, with every browser request intercepted locally. All figures are synthetic.

The loopback-only review at `http://localhost:4203/site-insights` is a clearly
labelled, synthetic, read-only-data UI preview. It contains no credentials and
connects to no database or mail provider. It is not production statistics and
does not replace the independently tested real store. Existing localhost:4200 is
left unchanged.
