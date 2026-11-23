# 0001. Package boundaries

- Status: accepted

## Decision
@if db
The monorepo consists only of the packages listed in `architecture.json`. Dependency direction:

```
@if api
@if web
web ──(import type only)──▶ api ──▶ core ──▶ db ──▶ domain
 │                           │       └────▶ contracts
 └──▶ contracts, domain      └──▶ contracts
@endif
@if !web
api ──▶ core ──▶ db ──▶ domain
 │      └────▶ contracts
 └──▶ contracts
@endif
@endif
@if !api
@if core
core ──▶ db ──▶ domain
└────▶ contracts
@endif
@if !core
db ──▶ domain
@endif
@endif
@if worker
worker ──▶ core, db, domain
@endif
```
@endif
@if !db
The monorepo consists only of the packages listed in `architecture.json`.
@endif

@if domain
- `domain` depends on no package and no external library.
@endif
@if contracts
- `contracts` depends only on `zod`; validation rules are written only here.
@endif
@if api
@if worker
- `api`/`worker` contain no business rules; they call `core` use cases. They import `db` only to wire up the connection (composition root).
@endif
@if !worker
- `api` contains no business rules; it calls `core` use cases. It imports `db` only to wire up the connection (composition root).
@endif
@endif
@if !api
@if worker
- `worker` contains no business rules; it calls `core` use cases. It imports `db` only to wire up the connection (composition root).
@endif
@endif
@if web
@if api
- `web` reaches the API only through `hc<AppType>`; it never imports `db`/`core`.
@endif
@if !api
- `web` is a standalone React SPA: no API client and no package dependencies.
@endif
@endif
- Relative imports across packages (`../../packages/...`) are forbidden.

## Enforcement
`scripts/arch-check.mjs` (`__RUN__ arch`): folder list, package names, package.json dependencies,
source imports, deferred dependencies, `@ts-ignore`/`@ts-nocheck`, empty placeholder files and the
CLAUDE.md scaffold block. Runs in the pre-commit hook, CI and the Claude Code Stop hook.
