# 5. Selectable Runtime: Node and Cloudflare Workers

Status: proposed

Partially supersedes ADR-0002 ("runtime stays Node").

## Context

Users want generated repos whose Apps deploy to Cloudflare Workers. Today every App assumes a
long-running Node process: `api` serves through `@hono/node-server`, `worker` runs pg-boss, `db`
opens a pooled postgres.js client, and env comes from `process.env`. A Cloudflare Worker has none
of these: it handles requests or events, reads config from bindings, and cannot hold a polling
loop.

## Decision

- A generated repo has exactly one **Runtime**: `node` (default) or `cloudflare`, chosen with
  `--runtime node|cloudflare` or a wizard prompt after the package manager. Only `cloudflare` is
  recorded, as `"runtime"` in `architecture.json`. A repo with no `runtime` field is `node`. On a
  target that already has `architecture.json`, a conflicting `--runtime` is an error, and a re-run
  with no `--runtime` keeps the recorded Runtime. The node output changes only in
  `guard-rules.mjs` and `arch-contract.mjs`, which gain the rules below. Every other node file is
  byte-identical.
- The Runtime is independent of the package manager and the Selection. bun + cloudflare is valid.
  A packages-only Selection accepts `--runtime` and records it, but writes no Cloudflare files.
- **Database:** Postgres stays and is reached through **Hyperdrive**. drizzle, postgres.js,
  migrations, `compose.yaml`, `--db-prefix` and worktree isolation are unchanged. Only `createDb`
  changes: it creates one client per request from the binding's `connectionString`. Locally,
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` is derived from `DATABASE_URL`, so
  each worktree still gets its own database.
- **`worker` App:** it becomes a Cloudflare Worker with a `queue()` handler (Cloudflare Queues)
  and a `scheduled()` handler (Cron Triggers). The `jobs` shape (`{ name, cron?, handle(db) }`)
  stays. The generated repo's ADR-0003 keeps its number but records "job queue: Cloudflare Queues".
- **`web` App:** it is its own Cloudflare Worker that serves static assets in SPA mode. In the
  api-connected form, `/api/*` goes first to a small forwarder that calls the `api` Cloudflare
  Worker through a **service binding**, giving the same origin the Vite proxy gives locally. `api`
  and `web` remain separate Cloudflare Workers, so Component boundaries hold.
- **Dev:** `api` and `worker` use `wrangler dev`. `web` uses `@cloudflare/vite-plugin`.
  `paseo.json` keeps assigning ports and env per worktree.
- **Env:** the `loadEnv(source)` signature stays. Its source is `process.env` on Node and the
  binding `env` on Cloudflare. Every `wrangler.jsonc` sets `nodejs_compat` (postgres.js needs it)
  and a `compatibility_date` that is a constant in the generator, bumped per release. It is not
  the scaffold date, which keeps goldens deterministic and avoids dates newer than the installed
  workerd.
- **Tests:** one root Vitest config on Node, as today. `@cloudflare/vitest-pool-workers` is
  Deferred. App tsconfigs use `wrangler types` output instead of `@types/node`, so Node-only APIs
  fail typecheck.
- **Deploy:** generated repos get `wrangler.jsonc`, `dev`/`build`/`deploy` scripts and
  `.dev.vars.example`. Generated CI runs only `wrangler deploy --dry-run`. Deploying, creating
  queues and Hyperdrive configs, and putting secrets are left to humans. The guard hook blocks
  agents in two tiers:
  - **Always, under every Runtime.** These are mutating wrangler commands, however they are
    invoked (bare, `npx`, `pnpm exec`, `pnpm dlx`, `bunx`). A node repo has no wrangler, so
    blocking them costs nothing:
    - `wrangler deploy` without `--dry-run` (`--dry-run=false` counts as a real deploy)
    - `wrangler versions upload|deploy`, `wrangler rollback` and `wrangler login`
    - `wrangler secret put|delete`
    - `wrangler queues create|delete` and `wrangler queues consumer add|remove`
    - `wrangler hyperdrive create|delete|update`
  - **Only when the contract's Runtime is `cloudflare`.** Running the `deploy` script
    (`pnpm run deploy`, `bun run deploy`, `turbo run deploy`). A node user's own `deploy`
    script must not be blocked. The contract reads `runtime`, defaulting to `node`.
- **Templates:** the block language gains Runtime terms (`@if cloudflare`, `@if node`, combinable
  with Component terms). Whole files that exist under only one Runtime are selected by a
  path → Runtime mapping next to `componentsNeededBy`: `wrangler.jsonc` and the
  `src/cloudflare.ts` entry exist only for cloudflare, `tsdown.config.ts` and `src/server.ts` only
  for node. No path ever has two writers (ADR-0003).
- **Generated ADRs:** the generated repo gets a cloudflare-only ADR-0005 "runtime: Cloudflare
  Workers". Node repos keep the gap, since ADR numbers are stable. The package-boundaries ADR is
  narrowed with blocks. In `architecture.json`, `role` texts and the `deps` of `deferred` entries
  follow the Runtime.

## Rejected

- **Per-App Runtime:** it multiplies the Closure and the golden matrix, and it forces `db` to
  serve two Runtimes at once.
- **D1 instead of Postgres:** it needs a different drizzle dialect and schema, and it means
  redesigning worktree isolation. It may come later as a separate database option.
- **Cloudflare Workflows for jobs:** too far from the current simple job model.
- **Deferring `worker` on cloudflare:** it leaves the default Selection unusable there.
- **Parallel per-Runtime template trees:** they would duplicate most template content.

## Consequences

- Goldens add cloudflare + default Selection and cloudflare + standalone `web`. The latter is
  an assets-only Cloudflare Worker that no other case pins. Every other Selection × Runtime is
  covered by invariant sweeps rather than goldens.
- A test reads every generated `wrangler.jsonc` together and checks that the bindings agree with
  each other. `wrangler deploy --dry-run` accepts mismatched names.
- CI's e2e job gains a Runtime axis. On cloudflare it runs `verify` and
  `wrangler deploy --dry-run` per App, then boots each Cloudflare Worker locally and calls it.
  Pack smoke only checks that the cloudflare files exist, so wrangler and workerd are not
  downloaded on three OSes.
- The block checker (and so lint-templates) accepts Runtime terms.
- Accepted residual risk: no test touches real Hyperdrive or Queues, because deploying is left
  to humans.
