# London Screenings — Screening Alerts Stage 1

Prepared 9 October 2026 for **London Screenings — App Development**. This is a manual-install development package, not a deployed feature. It contains complete database and Edge Function files, isolated validation tools and installation instructions.

Stage 1 supports independently followed TMDB films, secure account-scoped preview requests, a durable performance ledger, conservative detection and one London morning preview per account/date. **No email transport exists. Database constraints prohibit enabling sending or granting email permission.** No repository branch, commit, migration, deployment, secret change, schedule or email send has been performed.

Start with [manual-install/INSTALL.md](manual-install/INSTALL.md), then consult [MANIFEST.md](manual-install/MANIFEST.md) for the exact files to copy. Do not overlay this whole directory on the application repository: its root package files are an isolated test harness.

The inspected application is `eastoye/London-Screening`, main commit `0cdddd24583d761b9c109913d2bbfdab864bc239`. **The live frontend's Supabase project was confirmed on 10 October 2026 as `czsknzrtumbdweusfyhk`.** Its deployed client and native-watchlist adapter use that project, which still lacks the native-watchlist table/function. See [LIVE-BACKEND-VERIFICATION.md](manual-install/LIVE-BACKEND-VERIFICATION.md). This package does not repair that separate deployment discrepancy; Stage 1 is also not installed.

## Validation

Run in this extracted package, separately from the application's dependencies:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run build:functions
```

See [TEST-RESULTS.md](manual-install/TEST-RESULTS.md) for the actual local results and the remaining staging checks. The tests use PostgreSQL through PGlite and mocked HTTP services; they do not modify Supabase or contact TMDB/Resend.

## Operational limits and semantics

| Concern | Stage 1 behavior |
| --- | --- |
| Film identity | Positive confirmed `movies.tmdb_id`, `match_status = 'matched'`; no candidate/title matching |
| Subscription boundary | Server time after account/detector locks; remove/refollow and pause/resume establish new generations |
| Existing screenings | Baseline, including unmatched/inactive rows and older rows discovered later |
| Source evidence | Latest mapped import must be completed successfully within 36 hours; row must have been seen inside that run |
| Identity policy | Explicit venue mapping and approved source ID forms; ICA and David Lean disabled |
| Temporary holds | Failed/running/stale imports, missing/inactive rows and unconfirmed film identity remain reconsiderable |
| Final decisions | Baseline, trusted sold-out/expired performances, cancelled recipient items; identity conflicts quarantined |
| Deduplication | Durable source key and unique account/source item; previews never erase those keys |
| Collection | 08:00 inclusive to 12:00 exclusive in `Europe/London`; at most one preview per account/local date |
| Overflow | Later new/overflow performances remain pending for a subsequent morning, subject to fresh eligibility checks |
| Follow limit | 200 active films per account, configurable in the private control table (1–1,000) |
| User API quota | 30 requests/account/minute and 1,000 total/minute; includes read/search/follow/remove/pause/resume |
| Detection | Default 500, maximum 1,000 newly collected references and evaluated performances per call; oldest-evaluated first |
| Preview limits | At most 50 accounts/call and 200 performances/preview; this bounds output, not every query's total work |
| Retention | Last 100 run reports and roughly seven days of preview content; durable ledger/items retained for deduplication |
| Account deletion | Cascades personal subscriptions, preferences, recipient items and previews |
| Scheduling | Manual invocations only in this package; no cron installation |

The 36-hour policy intentionally holds previously valid screenings after a failed or running latest fetch. `unknown` availability can qualify and is reported honestly; it is not a promise of tickets. A trusted sold-out first exclusion remains final even if availability later changes.

Source evidence is read in one statement for each evaluation and rechecked in one statement before a preview is created. Existing importers remain multi-batch operations. These checks reduce partial-import exposure; they do not make an importer transactional. Preview content is diagnostic, not a frozen provider delivery payload.

## Stage 2 boundary

Existing Stage 1 follows are preview requests, **not permission to email**. Stage 2 must add explicit permission plus alert-specific mailbox verification bound to the current Auth email, and establish a new activation time/generation. Cancel Stage 1 pending items at that transition; never promote a preview or historical preview item into an email delivery.

Stage 2 also needs immutable attempted payloads, delivery leases/recovery, Resend idempotency and delivery-ID tags, authenticated idempotent webhooks, consent/address rechecks, provider suppression, token-authorised unsubscribe and capacity accounting. Stage 3 adds frontend controls and the live pilot. Neither stage is included here.
