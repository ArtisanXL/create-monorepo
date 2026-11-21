# 0001. Package boundaries

- Status: accepted

## Decision
The monorepo consists only of the packages listed in `architecture.json`. Dependency direction:

```
web ──(import type only)──▶ api ──▶ core ──▶ db ──▶ domain
 │                           │       └────▶ contracts
 └──▶ contracts, domain      └──▶ contracts
worker ──▶ core, db, domain
```

- `domain` depends on no package and no external library.
- `contracts` depends only on `zod`; validation rules are written only here.
- `api`/`worker` contain no business rules; they call `core` use cases. They import `db` only to wire up the connection (composition root).
- `web` reaches the API only through `hc<AppType>`; it never imports `db`/`core`.
- Relative imports across packages (`../../packages/...`) are forbidden.

## Enforcement
`scripts/arch-check.mjs` (`__RUN__ arch`): folder list, package names, package.json dependencies,
source imports, deferred dependencies, `@ts-ignore`/`@ts-nocheck`, empty placeholder files and the
CLAUDE.md scaffold block. Runs in the pre-commit hook, CI and the Claude Code Stop hook.
