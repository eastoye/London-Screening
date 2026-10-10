# London Screenings

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-pdp6gh31)

React/Vite application with Supabase Auth, screening data and Edge Functions.

## Application development

The root `package.json` and `package-lock.json` belong to this application.
They include React, React DOM, Supabase, fflate, Vite and the React Vite plugin.

```sh
npm ci
npm test
npm run build
```

The application test command includes `src/movieImport/*.test.js` and
`src/*.test.js`. Keep those tests. Run the separate Screening Alerts validation
package outside the application; never copy its dependency files over these files.

Frontend deployment uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
Only the public client key belongs in frontend configuration. Service-role,
TMDB and worker credentials belong in Supabase server secrets.

## Authentication

London Screenings uses Supabase email/password authentication:
sign up, log in, local log out and password recovery. Local log out preserves
the independent Trakt connection. A password-recovery link redirects to the
application's new-password form.

## Native watchlists

Native watchlists use `public.user_watchlist` and
`supabase/functions/native-watchlist-movies/index.ts`.
The function independently verifies the signed-in user and fetches film
metadata from TMDB before writing. Owners can read and remove their saved
films; browser clients cannot insert or update metadata directly.
Film identity is the exact TMDB ID. Trakt remains independent.

## Screening Alerts Stage 1

Users explicitly follow films independently of their watchlist.
Stage 1 provides subscriptions, conservative detection and morning dry-run
previews. Database constraints keep email permission and sending disabled.
There is no Resend transport. Email delivery is Stage 2; frontend alert
controls and the pilot are Stage 3.

Installed source locations:

- `supabase/config.toml`: actual function configuration.
- `supabase/functions/screening-alerts/index.ts`: authenticated user API.
- `supabase/functions/process-screening-alerts/index.ts`: secret-protected worker.
- `supabase/functions/_shared/screeningAlertsStage1.ts`: shared handler.
- `supabase/migrations/`: database migration source records.
- `supabase/manual-install/`: reference/manual SQL scripts, including
  `verify_user_watchlist.sql` for read-only watchlist checks.

The request and detector manual SQL files duplicate the installed migration
definitions. Do not execute them again on an installed project.

### Verified installation on 10 October 2026

The observed live frontend uses Supabase project `czsknzrtumbdweusfyhk`.
Watchlist storage and its Edge Function are installed. Both alerts Edge
Functions and all Stage 1 database routines are installed. Deployed watchlist
and alerts source matches GitHub commit
`2868a86d8f56ff10dd7171e45f0d671d4adb4edb`.

Installed feature migrations:

- `20261010083226_create_user_watchlist`
- `20261010085305_screening_alerts_stage1_schema`
- `20261010095408_screening_alerts_stage1_requests`
- `20261010095434_screening_alerts_stage1_detector`

The alert baseline was seeded once at
`2026-10-10T10:23:34.985941Z`, covering 18,360 existing screenings.
Two committed dry runs produced zero historical alert items, previews or
emails. Never reset or reseed that baseline.

The 38-venue mapping includes Electric Cinemas and Olympic Cinemas grouped
ownership. ICA and David Lean remain excluded for unstable performance
identities. Matching remains exact and confirmed.

### Remaining integration and acceptance

The alerts API's origin preflight and worker returned HTTP 503
`not_configured` during verification. In Supabase Edge Function secrets, set:

- `SCREENING_ALERTS_APP_URL=https://london-screenings-tq8c.bolt.host`
- `SCREENING_ALERTS_WORKER_SECRET`: a fresh private random secret, 32–512 characters.

Confirm the existing server `TMDB_READ_ACCESS_TOKEN`. Supabase supplies
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
Never put private credentials in GitHub, chat or frontend environment variables.

Complete signed-in watchlist search/save/duplicate/remove testing, valid-session
alerts requests, an authorised worker HTTP call, two-account JWT isolation and
concurrency checks before closing Stage 1 acceptance. Database role/claim
isolation tests passed with fixtures rolled back; those tests do not replace
real Auth sessions or concurrent sessions.

Keep delivery disabled. No alerts cron job was added.
Importer failures and TMDB coverage improvements are separate tasks.
