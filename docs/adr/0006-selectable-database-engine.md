# 6. Selectable Database engine: Postgres, MySQL, SQLite and D1

Status: proposed (2026-11-24)

Partially supersedes ADR-0005 ("D1 instead of Postgres" is no longer rejected).

## Context

Every generated repo assumes Postgres: `db` uses drizzle with postgres.js, `scripts/worktree.mjs`
gives each worktree its own Postgres database, `compose.yaml` runs Postgres, and the node `worker`
uses pg-boss. ADR-0005 rejected D1 for the `cloudflare` Runtime but said it "may come later as a
separate database option". Users now want to choose the database.

## Decision

- A generated repo has exactly one **Database engine**: `postgres` (default), `mysql`, `sqlite` or
  `d1`, chosen with `--database postgres|mysql|sqlite|d1` or a wizard prompt after the Runtime.
  Only a non-default engine is recorded, as `"database"` in `architecture.json`; no field means
  `postgres`. On a target that already has `architecture.json`, a conflicting `--database` is an
  error, and a re-run with no `--database` keeps the recorded engine. A Selection without `db`
  accepts the flag and records it but writes no database files. Node + `postgres` output stays
  byte-identical except for the guard and contract rules that read the new field.
- The engine depends on the Runtime. An invalid pair is an `OptionsError` that lists the valid
  engines, with no silent fallback, and the wizard offers only valid engines.

  | Engine     | `node`                | `cloudflare`      |
  | ---------- | --------------------- | ----------------- |
  | `postgres` | postgres.js           | Hyperdrive        |
  | `mysql`    | mysql2                | Hyperdrive        |
  | `sqlite`   | better-sqlite3        | not valid         |
  | `d1`       | not valid             | D1 binding        |

- **`worker` on node** needs Postgres, because pg-boss does. With `mysql` or `sqlite` the `worker`
  App is Deferred and the default Selection is computed without it; asking for it explicitly is an
  error. The `cloudflare` Runtime is unaffected, since it uses Cloudflare Queues.
- **Local isolation per worktree:**
  - `postgres`: unchanged.
  - `mysql`: `compose.yaml` runs MySQL and each worktree gets its own database.
  - `sqlite`: no `compose.yaml`; `DATABASE_URL` is a per-worktree file path.
  - `d1`: no `compose.yaml`; `wrangler dev` keeps local D1 state in a per-worktree `--persist-to`
    directory.
- `--db-prefix` stays valid for every engine: the database name prefix for `mysql`, the file name
  base for `sqlite`, the `database_name` base for `d1`.
- **D1 migrations:** `drizzle-kit generate` writes SQL and `wrangler d1 migrations apply` applies
  it (`--local` in dev). `drizzle-kit migrate` over d1-http is not used, so no API token is needed.
  The guard hook blocks, under every Runtime, `wrangler d1 create|delete` and
  `wrangler d1 migrations apply --remote` (and `execute --remote`), like the Hyperdrive commands in
  ADR-0005.
- **Templates:** the block language gains engine terms (`@if postgres|mysql|sqlite|d1`),
  combinable with Component and Runtime terms. Files that exist under one engine only are chosen by
  a path → engine mapping next to `componentsNeededBy`. No path has two writers (ADR-0003). The
  `CLAUDE.md` block's database lines follow the engine.
- **Generated ADRs:** 0003 (job queue) and 0004 (worktree isolation) are narrowed with blocks, and
  the database sentences of 0005 follow the engine. A non-default engine adds a generated
  ADR-0006 "database engine: X"; node + `postgres` repos keep the gap, since ADR numbers are stable.
- **`architecture.json`:** the `db` Package's `external_allow` and `deferred` dependencies follow
  the engine (`postgres`, `mysql2`, `better-sqlite3`, none for `d1`). Guard and contract read
  `database`, defaulting to `postgres`.

## Rejected

- **Hosted variants (libSQL/Turso, PlanetScale, Neon):** out of scope; they can later be extra
  drivers under an existing engine.
- **A portable table-backed job runner, or Redis, for `worker` on mysql/sqlite:** new
  infrastructure or a new queue implementation for a niche combination.
- **`drizzle-kit migrate` over d1-http for D1:** needs an API token and breaks the rule that
  humans own remote state.
- **`@libsql/client` and `node:sqlite` for sqlite:** the first opens the door to hosted variants,
  the second has no official drizzle driver and is still experimental (to be re-checked).
- **Parallel per-engine template trees:** they would duplicate most template content.
- **`--db` as the flag name:** too close to `--db-prefix`.

## Consequences

- Goldens add node + `mysql`, node + `sqlite` and cloudflare + `d1`, each with the default
  Selection. Every other Selection × Runtime × engine pair is covered by invariant sweeps,
  including cloudflare + `mysql`.
- CI's e2e job gains an engine axis: a service container for `mysql`, none for `sqlite`, and
  `wrangler deploy --dry-run` plus a local boot for `d1`. Pack smoke checks only that the engine
  files exist.
- The block checker (and so lint-templates) accepts engine terms.
- `better-sqlite3` is a native dependency, so the generated `package.json` must carry the
  package manager's build-script approval.
- Accepted residual risk: no test touches a real Hyperdrive, MySQL on Hyperdrive or remote D1,
  because deploying is left to humans.
