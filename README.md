# Staff Server

## Local setup

1. Install dependencies:
   ```bash
   npm ci
   ```
2. Create a `.env` from `.env.example` and fill in required values.
3. Run migrations:
   ```bash
   npm run build
   node dist/migrationsCheck.js
   ```
4. Start the server:
   ```bash
   npm start
   ```

## Required environment variables

The service expects these to be set (see `.env.example`):

- `NODE_ENV`
- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `BUILD_TIMESTAMP`
- `COMMIT_SHA`

Additional configuration is optional but recommended (rate limits, lockout policy, token expirations).

## API Contract (Critical)

### Auth
- `POST /auth/otp/start`
- `POST /auth/otp/verify` → `{ token }`

### Telephony
- `GET /telephony/token` → `{ token }`

### Health
- `GET /health` → `{ ok: true }`

## Common commands

- `npm run build` – compile TypeScript into `dist/`
- `npm test` – run Vitest test suites
- `npm run migrate:check` – validate migrations and schema
- `npm start` – run the compiled server

## Azure App Service startup

Configure the App Service startup command to run the compiled server entrypoint directly:

```bash
az webapp config set \
  --resource-group <your-rg> \
  --name <your-app-name> \
  --startup-file "node dist/index.js"
```

Recommended app settings for Node 20 + Oryx build on App Service:

```bash
az webapp config appsettings set \
  --resource-group <your-rg> \
  --name <your-app-name> \
  --settings \
    SCM_DO_BUILD_DURING_DEPLOYMENT=true \
    ENABLE_ORYX_BUILD=true \
    WEBSITE_NODE_DEFAULT_VERSION=20
```

Avoid static-site startup modes (such as `serve`, blank startup commands, or SPA defaults) so
`/api/*` requests are handled by the Node server process.

## Health endpoints

- `GET /api/_int/health` – liveness (process up)
- `GET /api/_int/ready` – readiness (env + database connectivity)
- `GET /api/_int/version` – build and schema version info

## Client submission flow (Phase 5)

Client applications can be submitted without authentication:

- `POST /api/client/submissions`
- `POST /api/client/documents` (alias: `/api/client/documents/upload`)

Payloads must include `submissionKey`, `productType`, `business`, `applicant`, and `documents`.
Submissions are idempotent by `submissionKey`, persist applications in `DOCUMENTS_REQUIRED`, and attach documents
as version 1 for each document type. Invalid or incomplete payloads are rejected.

## Lender transmission lifecycle (Phase 5)

Staff submit applications for lender transmission via:

- `POST /api/lender/submissions`

On success, submissions are logged with lender-specific payload mappings and the application
transitions to `OFF_TO_LENDER`. Failures record lender responses and move the pipeline to
`DOCUMENTS_REQUIRED` (retryable) or `DECLINED` (non-retryable) with reason codes.

Admin visibility and controls:

- `GET /api/admin/applications/:id/transmission-status`
- `POST /api/admin/transmissions/:id/retry`
- `POST /api/admin/transmissions/:id/cancel`

## Retry behavior

Failed lender submissions create retry state with exponential backoff and a maximum retry count.
Manual retries can be triggered via admin endpoints and are fully audited.

## Portal admin helpers

- `POST /api/portal/applications/:id/promote` – promote to the next valid stage (requires `reason`)
- `POST /api/portal/applications/:id/retry-job` – force retry of the latest failed processing job
- `GET /api/portal/applications/:id/history` – application stage history (supports pagination + filters)
- `GET /api/portal/jobs/:id/history` – processing job history (supports pagination + filters)
- `GET /api/portal/documents/:id/history` – document status history (supports pagination + filters)

## Audit history views

Read-only history views back the portal endpoints:

- `application_pipeline_history`
- `document_status_history`
- `processing_job_history`

## Business intelligence reporting

Admin-only reporting endpoints are available under `/api/reporting`:

- `GET /api/reporting/pipeline/summary`
- `GET /api/reporting/pipeline/timeseries`
- `GET /api/reporting/lenders/performance`
- `GET /api/reporting/applications/volume`
- `GET /api/reporting/documents/metrics`
- `GET /api/reporting/staff/activity`

BI aggregation jobs can be controlled via:

- `BI_JOBS_ENABLED` (default: enabled in production, disabled in test)
- `BI_DAILY_JOB_INTERVAL_MS`
- `BI_HOURLY_JOB_INTERVAL_MS`

## OCR pipeline

OCR jobs can be queued and reviewed via admin endpoints:

- `POST /api/admin/ocr/documents/:documentId/enqueue`
- `POST /api/admin/ocr/applications/:applicationId/enqueue`
- `GET /api/admin/ocr/documents/:documentId/status`
- `GET /api/admin/ocr/documents/:documentId/result`
- `POST /api/admin/ocr/documents/:documentId/retry`

Disable OCR by setting `OCR_ENABLED=false` or by enabling the OCR kill switch
(`OPS_KILL_SWITCH_OCR=true` or `POST /api/admin/ops/kill-switches/ocr/enable`).

## Additional environment variables

- `CLIENT_SUBMISSION_RATE_LIMIT_MAX`
- `CLIENT_SUBMISSION_RATE_LIMIT_WINDOW_MS`
- `CLIENT_SUBMISSION_OWNER_USER_ID`
- `DOCUMENT_ALLOWED_MIME_TYPES` (comma-separated)
- `DOCUMENT_MAX_SIZE_BYTES`
- `LENDER_RETRY_BASE_DELAY_MS`
- `LENDER_RETRY_MAX_DELAY_MS`
- `LENDER_RETRY_MAX_COUNT`
- `ENABLE_RATE_LIMITING` (default: true)
- `ENABLE_AUDIT_HISTORY` (default: true)
- `ENABLE_RETRY_POLICY` (default: true)
- `ENABLE_IDEMPOTENCY` (default: true)
- `OCR_ENABLED` (default: true)
- `OCR_PROVIDER` (default: openai)
- `OCR_TIMEOUT_MS`
- `OCR_MAX_ATTEMPTS`
- `OCR_WORKER_CONCURRENCY`
- `OCR_POLL_INTERVAL_MS`
- `OPENAI_API_KEY`
- `OPENAI_OCR_MODEL`

## Fraud protection (KS_SERVER_v9_FRAUD)

Sixteen checks (`src/fraud/`, plan keys `fraud_1`..`fraud_16`): starter 1, 2, 4, 5; growth adds 6, 7, 8; pro has all.
The fraud worker (`src/workers/fraudWorker.ts`, every minute, one instance) queues applications with new documents,
fresh banking results or a submission, runs the checks the plan includes, stores them in `fraud_check_results`, shares
confirmed fraud with the watchlist (opt-in) and alerts Admins about inside-job events. Staff API: `/api/fraud/...`
(see `src/routes/fraud.ts`); client beacon: `POST /api/client/fraud-signals`.

Every outside service is optional. A check whose service is not set reports `not_configured` - never a pass.

| Variable | Used by | Without it |
| --- | --- | --- |
| `KS_WATCHLIST_PEPPER` (16+ chars, the SAME on every Keystone copy) | 13 shared watchlist | watchlist reports "not set up" |
| `KS_OPS_URL`, `KS_LICENSEE_ID`, `KS_OPS_KEY` | 13 (already set for usage reports) | watchlist reports "not set up" |
| `CORPORATIONS_CANADA_API_KEY` (ISED API store, `user-key`) | 6 registry, directors | registry part "not set up" |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (already set) | 6, 7 line type (Lookup v2, about 1 cent each, cached 30 days) | phone part "not set up" |
| `IPINFO_TOKEN` (ipinfo.io; VPN flags need its privacy data) | 9 IP country, region, network, VPN | device sharing still checked |
| `FLINKS_BASE_URL`, `FLINKS_CUSTOMER_ID`, `FLINKS_AUTH_KEY` (optional) | 3 statement vs live bank - only with the `bank_connect` add-on (below) | "not set up" |
| `FRAUD_RDAP=off` | 6, 7 domain age via rdap.org (public, on by default) | - |
| `FRAUD_STAFF_HOURLY_FILE_LIMIT` (default 150) | 14 high-volume alert | - |
| `FRAUD_EXTRA_DISPOSABLE_DOMAINS` (comma separated) | 7 | built-in list only |
| `FRAUD_IDV_PROVIDER`, `FRAUD_VOICE_PROVIDER`, `FRAUD_ADDRESS_PROVIDER` | 8, 15, 6 | no vendor is wired in yet: "not set up" |

**Bank connect is a hidden add-on, not a plan feature** (KS_SERVER_BANK_CONNECT_ADDON). Keystone operations switches it
on for one licensee (`PUT /api/plan { "addons": { "bank_connect": true } }`, pushed by KS-Ops). While it is off (the
default) nothing about it exists on the copy: no Connect Bank (View-Only) applicant step or Request Items entry, no fraud
check 3 (not listed, not locked, not scored), no Flinks row on the Fraud settings card, and the bank-link routes answer
404. `GET /api/plan` lists `addons` with only the ones that are on.

What is stored (privacy): check results with plain-English reasons; per file its SHA-256 and 64-bit picture hashes,
image size and editor/camera flags (never a copy of an ID); from the client app a keyed hash of a random device id
the app generated, a keyed hash of the IP address plus its country/region/network, a keyed hash of a few answers,
and counts (seconds taken, fields completed, NAMES of sensitive fields that were pasted into) - never keystrokes or
typed values; staff-risk events with request key names, never values. Watchlist sharing sends only
HMAC(KS_WATCHLIST_PEPPER) hashes for files confirmed as fraud, and opting out deletes them at Keystone operations.

## PGI referrals to the insurance partner (KS_SERVER_v11_PGI)

Every licensee is a referral source of Keystone's insurance partner, Boreal Insurance, on every plan (`pgi_referrals`),
paid 20% of the partner's commission on each bound policy. When a client ticks PGI on Step 6 (or staff press "Refer for
PGI" on the application's PGI insurance tab) the file is referred; documents in the PGI categories are sent when they
are accepted (the system's signed term sheet goes as it is); the partner's messages, document requests, reminders and
status updates arrive signed at `POST /api/pgi/bi-events` and notify the referring seat, the Admins and the support
inbox. Code: `src/pgi/`, `src/routes/pgi.ts`, worker `src/workers/pgiReferralWorker.ts` (every 10 minutes).

| Variable | Without it |
| --- | --- |
| (none to set by hand) the partner link arrives from Keystone operations: `PUT /api/pgi/link` with `KS_OPS_KEY` | referrals wait as "Waiting for setup" and are sent once linked |
| `KS_SECRETS_KEY` (optional, 32+ chars) | the stored partner API key and callback secret are encrypted with a key derived from `JWT_SECRET` |
| `KS_PGI_ALLOWED_HOSTS` (optional, comma separated) | the partner server must be an `https://*.azurewebsites.net` address |

## Custom roles and permissions (KS_SERVER_CUSTOM_ROLES, Pro)

Admins build roles from a permission matrix in **Settings > Users & roles**: for contacts, companies, applications and
deals, lenders, documents, communications, calls and recordings, marketing, reports, settings, billing and users, each
of view / create / edit / delete / export, plus record visibility (own / team / all).

- Every custom role starts from a built-in role (Admin, Ops, Staff or Marketing) and can only take permissions away
  from it. The person's `users.role` stays the base role, so all existing role checks, the Marketing seat count and
  "notify the admins" keep treating them as that role; `users.custom_role_id` adds the matrix on top.
- The built-in roles are read-only templates (`src/roles/permissions.ts` `TEMPLATES`). People on a built-in role are
  never checked against a matrix: their access is exactly what it was (the unit suite checks every route in the
  registry against the templates).
- Enforcement is on the server, in both staff auth middlewares (`src/roles/enforce.ts`): the route's area comes from
  its path, the action from the method (POST search/preview = view, bulk-delete = delete, `/export` and `.csv` =
  export). A refusal is 403 `permission_denied` with a plain-words message. Personal endpoints (own profile, own
  sessions, the plan's feature list, field definitions) are always allowed.
- Only a full Admin (built-in Admin, no custom role) can create or change roles or change anyone's role. A role built
  from Admin can run users and settings but never hand out roles, so it cannot widen itself.
- Record visibility: a custom role carries its own own/team/all; a per-person override on Settings > Teams still wins.
- Plan: `custom_roles` is Pro. After a downgrade, existing custom roles keep applying (restrictions are never lifted by
  a plan change); Admins can still move people back to built-in roles, but cannot create or edit custom roles.
- API: `GET /api/roles/me` (every staff member: role, matrix, visibility), `GET/POST/PATCH /api/roles`,
  `POST /api/roles/:id/archive|unarchive`. Assign with `PATCH /api/users/:id { custom_role_id }` (or `{ role }` for a
  built-in role; `POST /api/users { custom_role_id }` when inviting). Every change is in `audit_events`
  (`custom_role` created / updated / archived / assigned, with before and after).
- Migration `2026_11_05_ks_custom_roles.sql` (idempotent) adds `custom_roles` and `users.custom_role_id`; it assigns
  nobody a custom role.

## Phone numbers bought through Twilio (KS_SERVER_PHONE_PROVISIONING)

Numbers are bought into this copy's own Twilio account (`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, which may be a
subaccount): the account whose auth token signs the webhooks must own the numbers. Each number bought gets this copy's
webhooks straight away: voice `POST {server}/api/webhooks/twilio/voice/twiml`, call status
`POST {server}/api/webhooks/twilio/voice`, texts `POST {server}/api/webhooks/twilio/sms-inbound`. Code: `src/phone/`,
`src/routes/phoneNumbers.ts`, worker `src/workers/phoneNumberWorker.ts` (every 15 minutes, also while cancelled).

- Kinds and plan limits: one local business line on every plan (5 on Pro), the toll-free line on Growth (2 on Pro,
  `toll_free_number`), and a direct line per person on Pro (`multiple_lines`, one per seat). A running trial counts.
- Admins: Settings > Phone lines. `GET /api/phone-numbers`, `GET /api/phone-numbers/available?kind=&country=&area_code=&region=`,
  `POST /api/phone-numbers { kind, phone_number, user_id? }`, `POST /api/phone-numbers/:id/release`,
  `POST /api/phone-numbers/:id/keep { user_id? }`, `PUT /api/phone-numbers/:id/assign { user_id }`.
- Keystone operations: `POST /api/provision/phone-numbers { area_code, region, country }` (`KS_OPS_KEY`) buys the
  business line (and the toll-free line on Growth and Pro) once each during automatic provisioning.
- Never silent: a removed seat, a cancellation, a plan without the kind, or an admin's Release moves the number to
  `releasing` for the grace period; the Admins are emailed and notified, direct-line calls go to the main line
  meanwhile, and "Keep" cancels it. Every step is in `phone_number_events`; every Twilio failure is logged with its code.

| Variable | Without it |
| --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | numbers cannot be searched or bought (the page says so) |
| `KS_SERVER_URL` (https) | numbers are not bought: the webhooks would have nowhere to point (the dev fallback is never used) |
| `TWILIO_ADDRESS_SID` (optional, `AD...`) | numbers whose `address_requirements` is not `none` are refused with a plain explanation |
| `TWILIO_BUNDLE_SID` (optional, `BU...`) | only needed where Twilio asks for a regulatory bundle |
| `KS_NUMBER_RELEASE_GRACE_DAYS` (optional) | 30 days between "will be released" and the release |

Texting registration (KS_SERVER_TEXTING_REGISTRATION): Keystone operations sets up this copy's Twilio sub-account,
address and texting registration by itself and pushes the status here with `PUT /api/provision/texting`
`{ registrations: [{ kind: toll_free | a2p_10dlc, status, phone_number, reason, message }] }` (`KS_OPS_KEY`). The
address (`AD...`) and any regulatory bundle (`BU...`) it registered come with `POST /api/provision/phone-numbers` and
are used for every purchase unless `TWILIO_ADDRESS_SID` / `TWILIO_BUNDLE_SID` are set. Settings > Phone lines shows
the status in plain English (`GET /api/phone-numbers` -> `setup.messages`, `texting`). Texts to US mobiles go from the
brokerage's own toll-free line once its toll-free verification is approved (or from its US business line once A2P
10DLC is approved); until then they wait with a plain reason (`409 us_texting_pending` for staff sends) and Canadian
mobiles get texts from the business line. A copy that never received a status keeps the old rules
(`TWILIO_US_SMS_FROM`). Calls work straight away.

Dialler quick replies (KS_SERVER_QUICK_REPLIES_EVERY_PLAN): `GET /api/templates/quick` answers on every plan with the
built-in quick replies; the brokerage's saved templates and snippets are added on Growth and up (they stay a Growth+
feature everywhere else).

## Marketing add-on and e-signing allowance (KS_SERVER_MARKETING_ADDON)

Every plan markets to its own client list (`src/plans/marketing.ts`, Todd Oct 26). Per brokerage, per month:

| | Starter | Growth | Pro | Marketing add-on (any plan) |
| --- | --- | --- | --- | --- |
| Campaign emails | 500 | 1,000 | 2,500 | +10,000, then $10 per 10,000 (or part) on the next bill |
| People per text-to-many send | 50 | 250 | 500 | 1,000 (+1,000 bonus marketing texts a month) |
| Sequences running at once | 2 | 5 | 10 | unlimited |
| Visitor-tracking history | 30 days | 90 days | 365 days | full, plus session replay |
| Website lead forms | 1 | 1 | 1 | unlimited, plus the AI chat widget and tracking script |

- The add-on (`addons.marketing`, pushed by KS-Ops with the plan, `PUT /api/plan { addons: { marketing } }`) is $49 a
  month, flat, any plan; Pro does not include it. Both trials include it (the in-app Pro trial, and the staff free
  trial: service status `trial`). `GET /api/plan` has a `marketing` block (the add-on, the limits in force, every
  plan's limits, which tools come from the plan or the add-on) and `signings`.
- Advanced tools (`requireMarketingTool`, `src/plans/marketingGate.ts`): website kit extras, session replay, full visitor
  history, full Google Ads tools (attribution, ad-waste, Customer Match, Monday ads email, AI suggestions), lead
  scoring, A/B subject test, best send time, funded-deal campaign report. A tool the plan already has (session replay
  on Growth and Pro, Google Ads tools on Pro) works as before. Via the add-on: Admins plus the first 3 active
  Marketing users (402 `marketing_addon_required` / 403 `marketing_seat_required`). User Management refuses a 4th
  active Marketing user while the add-on is on (409 `marketing_seat_limit`). Marketing users count as seats.
- Google Ads results (`GET /api/marketing/google-ads`, `/google-ads/history`), LinkedIn Ads results and Google
  Analytics are on every plan. Campaign templates (`/api/marketing/templates`, the branded email) are on every plan;
  message templates and snippets (`/api/templates`) and automations stay Growth and up.
- Meters (`usage_events`, `src/plans/meters.ts`): `campaign_email` (blasts, text fallback emails, sequences),
  `marketing_text`, `signing` (every SignNow invite, metered in `src/signnow/signnowClient.ts`: one per signer per
  document or group, so a re-sent invite or new link is not counted twice: application, Accord, fee agreements,
  term sheets, SBA forms, personal net worth statements, referrer and broker agreements). Without the add-on a
  campaign that does not fit in what is left is refused (409 `campaign_email_limit`) and sends stop at the allowance;
  sequence and fallback emails wait for the 1st. Signings are never blocked: 4 a month are included, each one over is
  $2.50. The usage report to KS-Ops carries `campaign_emails`, `marketing_texts`, `signings`, `marketing_addon` and
  the overage; 80% / 100% emails go out for signings and campaign emails like minutes and texts.
- Campaign sends: `campaign_sends` (one row per job and person; SendGrid `cs_id` fills opened, clicked, unsubscribed).
  `POST /api/marketing/email/send(-template)` takes `abTest { subjectB, testPercent 10-50, waitHours 1-24 }` or
  `sendTime: "best"` (add-on). The send-queue worker runs them in phases (`src/marketing/campaignRunner.ts`).
  `GET /api/marketing/campaign-report?days=90`: sent, opened, clicked, unsubscribed per email and text campaign on
  every plan; with the add-on, applications and funded deals (and amount) by the people reached within 90 days.
- Website kit: staff `GET/PUT /api/website-kit` (settings, forms, snippet; audited); public `/api/kit/:key/kit.js`,
  `POST /api/kit/:key/forms/:formId` (a CRM lead: tags, lead rotation "website", express consent, timeline, staff
  notified), `/chat` (the brokerage's assistant), `/track` and `/consent`. The kit answers only the website addresses
  the Admin listed, and tracks nothing until the visitor agreed (its banner, or the site calling
  `WebsiteKit.consent(true)`).
- Lead scoring (`src/marketing/leadScoring.ts`, worker every 30 minutes while the add-on is on): rules (phone, business,
  owner title, tags, stage, status, amount) plus 90 days of engagement (opens, clicks, text clicks, visits, form
  submissions, applications). `POST /api/lead-scores/lookup`, `GET /api/lead-scores/top` (staff),
  `GET/PUT /api/lead-scores/settings` (Admins and Marketing seats, audited).

## Ops Control Plane

Admin-only ops control plane endpoints live under `/api/admin/ops`:

- `GET /api/admin/ops/kill-switches`
- `POST /api/admin/ops/kill-switches/:key/enable`
- `POST /api/admin/ops/kill-switches/:key/disable`
- `POST /api/admin/ops/replay/:scope`
- `GET /api/admin/ops/replay/:id/status`

Example: list kill switches

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://server.boreal.financial/api/admin/ops/kill-switches
```

## Replay Procedures

Supported replay scopes are `audit_events`, `lender_submissions`, and `reporting_daily_metrics`.

Start a replay:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://server.boreal.financial/api/admin/ops/replay/audit_events
```

Check status:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://server.boreal.financial/api/admin/ops/replay/{replayJobId}/status
```

## Data Export Procedures

Admin exports are served under `/api/admin/exports` and accept a JSON payload with optional
`from`, `to`, `pipelineState`, `lenderId`, `productType`, and `format` (`json` or `csv`).

Pipeline summary export (JSON):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"2024-01-01","to":"2024-02-01","format":"json"}' \
  https://server.boreal.financial/api/admin/exports/pipeline
```

Lender performance export (CSV):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"lenderId":"default","format":"csv"}' \
  https://server.boreal.financial/api/admin/exports/lenders
```

Application volume export (CSV):

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productType":"term_loan","format":"csv"}' \
  https://server.boreal.financial/api/admin/exports/applications
```

## Backfill utility

Recompute pipeline and processing stages for legacy applications:

```bash
tsx scripts/backfillApplications.ts --dry-run --verbose
```

## Emergency Kill Switches

Kill switches can be toggled through the ops control plane or enforced via environment
variables (all default to `false`):

- `OPS_KILL_SWITCH_REPLAY`
- `OPS_KILL_SWITCH_EXPORTS`
- `OPS_KILL_SWITCH_LENDER_TRANSMISSION`
- `OPS_KILL_SWITCH_OCR`

Enable the exports kill switch:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://server.boreal.financial/api/admin/ops/kill-switches/exports/enable
```

Disable the exports kill switch:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://server.boreal.financial/api/admin/ops/kill-switches/exports/disable
```

Internal introspection (no auth):

```bash
curl https://server.boreal.financial/api/_int/ops
```

## Production safety defaults

- Request body limit is locked to `1mb` in the server bootstrap.
- Security headers are enabled globally via `helmet()`.
- CORS is restricted to configured allow-listed origins (`CORS_ALLOWED_ORIGINS`).
- Database pools are capped to avoid connection exhaustion.

### Health check enforcement (example)

```yaml
healthcheck:
  path: /healthz
  interval: 30s
```

### Pre-scale load test

Run this before promoting to production:

```bash
autocannon -c 50 -d 20 https://server.boreal.financial/api/leads
```
