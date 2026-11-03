# Shared hosting: one server, a database per brokerage

KS_SHARED_HOSTING_v1. KS-server's part of the contract `KS_SHARED_HOSTING_v1` (kept in KS-Ops): Keystone runs **one
shared server** (`ks-shared-server`) for every brokerage, and each brokerage keeps **its own database** (`ks_<code>`
on `ks-shared-pg`, opened with its own role `ks_<code>_app`, which can connect to nothing else).

## The two modes

| | Single-brokerage mode | Multi-brokerage mode |
|---|---|---|
| Switch | `KS_CONTROL_DATABASE_URL` **not** set | `KS_CONTROL_DATABASE_URL` set |
| Database | `DATABASE_URL` | each brokerage's own, from the registry |
| Settings | the App Service settings | shared App Service settings + each brokerage's own (`env_enc`) |
| Used by | the development copy, the demo server, CI, every test | `ks-shared-server` |

Single-brokerage mode is exactly the server as it was before: nothing in `src/tenancy/` changes its behaviour.

## Settings of the shared app

| Setting | What it is |
|---|---|
| `KS_CONTROL_DATABASE_URL` | Connection string for the control database `ks_control`, as the read-only role `ks_control_reader` (SELECT on `ks_tenants` only). Setting it turns multi-brokerage mode on. |
| `KS_TENANT_KEY` | The key the registry's encrypted values use (any length; the AES-256 key is SHA-256 of it). The same value as in KS-Ops, KS-Agent and the web host. |
| `KS_OPS_SERVICE_KEY` | The key KS-Ops sends as `X-KS-Ops-Service-Key` to the two ops endpoints below. Without it they answer 503. |

Keystone-wide values stay ordinary App Service settings on the shared app: `OPENAI_API_KEY`, `SENDGRID_API_KEY`,
`AZURE_STORAGE_CONNECTION_STRING`, `NODE_ENV`, `PORT`, the push (APNs/FCM) keys, `BF_WORKERS_ENABLED`,
`WORKER_STAGGER_MS`. `DATABASE_URL` and `JWT_SECRET` are **not** set on the shared app; every brokerage has its own.

## The registry

Table `ks_tenants` in `ks_control`, owned and written by KS-Ops (see the contract for the DDL). Per brokerage: its
`code`, `status` (provisioning | trial | active | past_due | suspended | cancelled), its host names (`api_hosts`,
`portal_hosts`, `client_hosts`, lowercase, no port or scheme), `database_name`, `database_url_enc` and `env_enc`.

Encrypted values use the shared format `v1:<iv base64>:<auth tag base64>:<ciphertext base64>` (AES-256-GCM, 12-byte
random IV, UTF-8). `env_enc` decrypts to a JSON object of string values. Code: `src/tenancy/crypto.ts`.

The server reads the whole table and keeps it for **60 seconds** (`src/tenancy/registry.ts`). While the control
database is unreachable it keeps answering from the last copy it read. A row that cannot be decrypted is skipped and
logged (`ks_tenant_row_unreadable`); that brokerage answers `unknown_brokerage` until it is fixed.

## How a request finds its brokerage

`src/tenancy/middleware.ts`, registered first in the app (before CORS, body parsing and auth):

1. the header `X-KS-Tenant: <code>` (KS-Agent, the native apps, server-to-server calls), otherwise
2. the `Host` header (lowercased, port removed) matched against `api_hosts`;
3. no match: `404 {"error":"unknown_brokerage"}`; status `cancelled`: `410 {"error":"brokerage_closed"}`;
   `suspended`: the existing behaviour (the service gate answers 423, from the brokerage's own plan state).

Webhooks (Twilio, Stripe, SendGrid, SignNow) arrive on the brokerage's api host and resolve the same way. `/`,
`/health`, `/healthz`, `/api/health` and `/api/_int/health` answer without a brokerage, and so do the ops endpoints.

Also answered by the middleware:

- `503 {"error":"brokerage_misconfigured"}`: the brokerage's `JWT_SECRET` is missing, short or a placeholder (the
  single-brokerage server refuses to start in that case; the shared server refuses to serve only that brokerage).
- `503 {"error":"brokerage_unavailable"}` with `Retry-After: 60`: its database could not be migrated (retried after a
  minute, or at once by the migrate endpoint).

The Team chat WebSocket (`/api/team/ws`) does not go through Express; it resolves the brokerage the same way on upgrade.

## What "the current brokerage" means inside the server

AsyncLocalStorage (`src/tenancy/context.ts`) carries `{ code, pool, env }` through every request and every
background job. Express is patched so every middleware and handler re-enters the request's brokerage, because body
parsers and multer call `next()` from stream callbacks.

- **Database.** The exported `pool` / `db` (`src/db.prod.ts`) and `runQuery` (`src/db.ts`) go to the current brokerage's
  pg Pool (`src/tenancy/pools.ts`): created on first use, at most 5 connections, idle connections closed after 30 s,
  the pool closed after 10 idle minutes. Using the database with no brokerage throws `no_brokerage_context`. Nothing
  ever falls back to another brokerage's database.
- **Settings.** `process.env` is replaced once at startup by an overlay (`src/tenancy/envOverlay.ts`). Inside a
  brokerage, a key it has in `env_enc` returns its value (a per-brokerage value overrides a shared one with the same
  name), and `DATABASE_URL` is its own database. A per-brokerage key it does **not** have returns `undefined`, never
  the shared app's value. Per-brokerage keys: `JWT_SECRET`, `JWT_REFRESH_SECRET`, `OTP_HASH_SALT`, `KS_LICENSEE_ID`,
  `KS_OPS_KEY`, `KS_OPS_URL`, `KS_PLAN`, `KS_SERVER_URL`, `KS_PORTAL_URL`, `KS_CLIENT_URL`, `CLIENT_URL`,
  `PUBLIC_BASE_URL`, `PUBLIC_SERVER_URL`, `MAYA_URL`, `KS_OAUTH_BROKER_URL`, `SENDGRID_FROM`, `SENDGRID_REPLY_TO`,
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, `WATCH_PUSH_ENCRYPTION_KEY`, `DATABASE_URL`, and every `QBO_*`, `TWILIO_*`,
  `KS_M365_*`, `KS_GOOGLE_*`, `SIGNNOW_*`. Every other key returns the shared App Service setting unless the brokerage
  has its own.
- **Code that read settings at import time** (`const X = process.env.Y` at the top of a module, the `config` object)
  now reads them when used; on the shared server `config.auth`, `config.jwt`, `config.twilio`, `config.client.url`,
  `config.urls`, `config.api.baseUrl` and `config.google` are live getters.
- **In-memory caches and rate limits** that would mix brokerages are kept per brokerage (`tenantLocal()`), or carry
  the brokerage code in their key (`tenantKey()`): OTP attempts and send limits, refresh-token replay guard, the plan,
  licensee settings, beta flags, security settings, texting state, the Twilio client, custom roles, visibility scopes,
  custom fields, the circuit breakers, Google/LinkedIn Ads and GA4/Clarity tokens and reports, Microsoft Graph tokens,
  QuickBooks refresh, every `express-rate-limit` key (`rateLimitKeyFromRequest`) and the Team chat sockets.

## Background jobs

`startup/backgroundWorkers.ts` is the same list of workers single-brokerage mode starts (moved out of `index.ts`
unchanged). The shared server (`src/tenancy/server.ts`) starts that list **once per brokerage**, inside the
brokerage's context, one brokerage at a time: the timers each worker creates keep that context, so every tick works
on that brokerage's database with its own settings. Each worker's ticks take turns across brokerages
(`serialAcrossTenants`, built into `claimedTick`), the cross-instance worker locks are per brokerage database, and an
error is logged with the brokerage's code without stopping the others.

A supervisor re-reads the registry every minute: a new brokerage (status trial, active, past_due or suspended) is
migrated and started, a cancelled or removed one is stopped, and one whose database URL, status or settings changed is
restarted. Provisioning and cancelled brokerages run no jobs. Suspended ones keep their workers, which pause
themselves as before (`workersPaused`). For anything else that must touch every brokerage, use
`forEachTenant(fn)` from `src/tenancy/jobs.ts` (it runs `fn` once, unchanged, in single-brokerage mode).

## Migrations

At startup the existing runner (`src/startup/runMigrations.ts`) runs against every brokerage database whose status is
not cancelled, one at a time, before the server listens. A failure is logged (`ks_tenant_migrate_failed`) and that
brokerage answers 503 until a migrate succeeds; the others start normally. An instance that meets a brokerage it has
not migrated yet (added after it started) migrates it before serving it. The runner's advisory lock keeps two
instances from migrating the same database at once. Migrations run as the brokerage's own role (not a superuser), so
they may not create extensions other than `vector`, which KS-Ops makes available when it creates the database.

## Ops endpoints (KS-Ops calls these)

Both need `X-KS-Ops-Service-Key: <KS_OPS_SERVICE_KEY>` (401 when wrong, 503 when the key is not configured).

| Endpoint | What it does |
|---|---|
| `POST /api/ops/tenants/reload` | Clears the registry cache (call it after writing `ks_tenants`); the supervisor re-reads at once. `{"ok":true}` |
| `POST /api/ops/tenants/:code/migrate` | Runs the migrations on that brokerage's database now and waits for them. `{"ok":true,"code":...,"ms":...}`; 404 unknown, 410 cancelled, 500 `{"error":"migration_failed"}`. Then starts its background work. |

## Deploys

`.github/workflows/deploy.yml` deploys the development copy and the demo server as before, and ONE shared app:
`ks-shared-server` (repository variable `AZURE_WEBAPP_NAME_SHARED`; `off` skips it), signing in with the GitHub
environment `ks-shared` (federated identity variables `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID`,
or the secret `AZURE_CREDENTIALS`). There is no per-licensee matrix any more. `deploy/licensees.json` is kept as the
list of brokerages whose web builds are published.

## Not on the shared server

- The demo server (`DEMO_MODE=true`) stays a single-brokerage server; `DEMO_MODE` is ignored in multi-brokerage mode.
- The startup admin bootstrap (`BOOTSTRAP_ADMIN_PHONE`) does not run: KS-Ops creates each brokerage's first admin
  through `POST /api/provision/admin` (sent with `X-KS-Tenant`).
- Files in Azure Blob Storage share the Keystone-wide storage account (`AZURE_STORAGE_CONNECTION_STRING`), as the
  contract lists it; blob names are unique ids, and access always goes through the brokerage's own database rows.
