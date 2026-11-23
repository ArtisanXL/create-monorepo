# 0005. Runtime: Cloudflare Workers

- Status: accepted

## Context
This repo targets Cloudflare Workers. A Worker handles requests or events and reads its config
from bindings; it holds no long-running process.

## Decision
- Every App is its own Cloudflare Worker with a `wrangler.jsonc`. The repo has one Runtime; it is
  recorded as `"runtime": "cloudflare"` in `architecture.json`.
- Every `wrangler.jsonc` sets the `nodejs_compat` flag (postgres.js needs it) and a
  `compatibility_date` that the generator pins per release.
@if api|worker
- **Database:** Postgres stays, reached through **Hyperdrive** (binding `__HYPERDRIVE_BINDING__`).
  `createDb` creates one client per request from the binding's `connectionString`. The Hyperdrive
  config is created by a human and its id goes into `wrangler.jsonc`. Locally, wrangler reads
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING___HYPERDRIVE_BINDING__`, derived from
  `DATABASE_URL`.
@endif
@if worker
- **Jobs:** `worker` handles jobs in a `queue()` handler (Cloudflare Queues) and recurring jobs in
  a `scheduled()` handler (Cron Triggers). It produces to its own queue. `api` does not enqueue.
@endif
@if web
- **UI:** `web` serves its static assets in SPA mode.
@endif
@if api web
- **API access:** `web` calls `api` through a service binding behind `/api/*`, giving the same
  origin the Vite proxy gives locally. The two stay separate Workers.
@endif
- **Env:** `loadEnv(source)` reads the binding `env` on Cloudflare, not `process.env`.
- **Tests:** one root Vitest config on Node. Workers types come from `wrangler types`; the file
  is generated before typecheck and gitignored.

## Deploying
- **Agents never deploy.** The guard hook blocks mutating wrangler commands (`wrangler deploy`
  without `--dry-run`, `wrangler secret put`, creating queues or Hyperdrive configs, and so on)
  and the `deploy` script.
- CI and agents run only `wrangler deploy --dry-run` (the `deploy:dry-run` script of each App).
- Deploying, creating Hyperdrive configs and queues, and putting secrets are done by humans.
