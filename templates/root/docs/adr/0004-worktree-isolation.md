# 0004. Per-worktree isolation (Paseo)

- Status: accepted

## Context
Agents and developers work in parallel git worktrees (Paseo, Claude Code, `git worktree add`).
Sharing one database or fixed ports between them causes collisions.

## Decision
- One shared local Postgres; isolation by name. The main checkout uses `__DB_PREFIX__`, every
  worktree `__DB_PREFIX___wt_<key>` (`<key>` = sanitized folder name + sha1 of the path).
@if worker
  pg-boss stores its queue in the same database, so jobs are isolated too.
@endif
- `scripts/worktree.mjs` (`__RUN__ worktree:setup|teardown|info|gc`) writes `.env` (copied from the
  source checkout, only isolated keys rewritten, placeholder secrets generated), creates the
  database, runs migrations, and drops it again on teardown. It never touches the main checkout's
  database; teardown always exits 0.
@if api web worker
- `paseo.json` runs setup/teardown and defines `api`, `web`, `worker` as services. Ports are
  assigned by Paseo (`servicePorts.range` 4100-4999) and never hard-coded; the web dev server
  proxies `/api` to `API_URL`. `.worktreeinclude` copies `.env` into new worktrees.
@else
- `paseo.json` runs setup/teardown and defines the apps as services. Ports are assigned by Paseo
  (`servicePorts.range` 4100-4999) and never hard-coded. `.worktreeinclude` copies `.env` into new
  worktrees.
@endif
- Paseo reads `paseo.json` from the base branch: changes take effect after merging to main.

## Consequences
Worktrees removed outside Paseo leave databases behind; `__RUN__ worktree:gc --yes` drops them.
