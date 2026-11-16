# --- Architecture contract -----------------------------------------------------------
emit architecture.json <<'EOF'
{
  "$comment": "Single source of truth. Humans only (agent hook + CODEOWNERS). Every change requires an accepted ADR.",
  "scope": "__SCOPE__",
  "test_allow": ["vitest"],
  "packages": {
    "packages/domain": {
      "adr": "docs/adr/0001-package-boundaries.md",
      "role": "Pure business rules and value objects (Money etc.). No I/O.",
      "may_depend_on": [],
      "external_allow": []
    },
    "packages/contracts": {
      "adr": "docs/adr/0001-package-boundaries.md",
      "role": "API input/output Zod schemas. Validation rules live only here.",
      "may_depend_on": [],
      "external_allow": ["zod"]
    },
    "packages/db": {
      "adr": "docs/adr/0001-package-boundaries.md",
      "role": "Drizzle schema, migrations, DB client.",
      "may_depend_on": ["packages/domain"],
      "external_allow": ["drizzle-orm", "drizzle-kit", "postgres"]
    },
    "packages/core": {
      "adr": "docs/adr/0001-package-boundaries.md",
      "role": "Use cases (actions/queries). Knows nothing about HTTP or queues.",
      "may_depend_on": ["packages/domain", "packages/contracts", "packages/db"]
    },
    "apps/api": {
      "adr": "docs/adr/0001-package-boundaries.md",
      "role": "Hono HTTP layer: validation + core calls. No business rules.",
      "may_depend_on": ["packages/core", "packages/contracts", "packages/domain", "packages/db"]
    },
    "apps/worker": {
      "adr": "docs/adr/0003-job-queue-pg-boss.md",
      "role": "pg-boss background jobs: core calls only. No business rules.",
      "may_depend_on": ["packages/core", "packages/domain", "packages/db"]
    },
    "apps/web": {
      "adr": "docs/adr/0001-package-boundaries.md",
      "role": "React SPA. Talks to the API only through the hc<AppType> client.",
      "may_depend_on": ["packages/contracts", "packages/domain"],
      "type_only": ["apps/api"]
    }
  },
  "deferred": [
    {
      "name": "auth",
      "path": "packages/auth",
      "trigger": "When real user sign-in becomes a requirement (preferred: better-auth).",
      "deps": ["better-auth", "lucia", "next-auth", "@auth/core", "passport", "jsonwebtoken", "jose"]
    },
    {
      "name": "i18n",
      "path": "packages/i18n",
      "trigger": "When a second UI language is requested.",
      "deps": ["i18next", "react-i18next", "@lingui/core", "@lingui/react", "react-intl", "@inlang/paraglide-js"]
    },
    {
      "name": "ui",
      "path": "packages/ui",
      "trigger": "When a second app needs the same components.",
      "deps": []
    },
    {
      "name": "config",
      "path": "packages/config",
      "trigger": "When the same env schema is duplicated in a third app.",
      "deps": ["@t3-oss/env-core", "dotenv", "convict"]
    },
    {
      "name": "integrations",
      "path": "packages/integrations",
      "trigger": "When the first third-party API integration is approved.",
      "deps": []
    },
    {
      "name": "crawler",
      "path": "apps/crawler",
      "trigger": "When a data need that the official API cannot cover (ToS) is approved.",
      "deps": ["crawlee", "playwright", "puppeteer", "cheerio"]
    },
    {
      "name": "e2e",
      "path": "apps/e2e",
      "trigger": "When the first critical user flow is complete.",
      "deps": ["@playwright/test", "cypress"]
    },
    {
      "name": "redis-queue",
      "path": null,
      "trigger": "When pg-boss hits a measured throughput limit.",
      "deps": ["bullmq", "bull", "ioredis", "redis"]
    }
  ],
  "protected_paths": [
    "architecture.json",
    "docs/adr/",
    "scripts/arch-check.mjs",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks/",
    ".githooks/",
    ".github/",
    "biome.json",
    "tsconfig.base.json",
    "turbo.json",
    "vitest.config.ts"
  ],
  "agent_writable_exceptions": ["docs/adr/proposed/"],
  "claude_md_block": {
    "$comment": "The scaffold block in CLAUDE.md is protected; everything outside it is free. If a human changes the block, update sha256 (pnpm arch --claude-hash).",
    "begin": "<!-- scaffold:begin",
    "end": "<!-- scaffold:end -->",
    "sha256": "__CLAUDE_SHA__"
  }
}
EOF

# --- ADRs ------------------------------------------------------------------------------
emit docs/adr/TEMPLATE.md <<'EOF'
# NNNN. Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## architecture.json change
```json
```
EOF

emit docs/adr/0001-package-boundaries.md <<'EOF'
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
`scripts/arch-check.mjs` (`pnpm arch`): folder list, package names, package.json dependencies,
source imports, deferred dependencies, `@ts-ignore`/`@ts-nocheck`, empty placeholder files and the
CLAUDE.md scaffold block. Runs in the pre-commit hook, CI and the Claude Code Stop hook.
EOF

emit docs/adr/0002-deferred-packages.md <<'EOF'
# 0002. Packages deferred until needed

- Status: accepted

## Context
Empty packages and `.gitkeep` folders signal "fill me" to agents and produce speculative code.

## Decision
Packages and dependencies listed under `architecture.json > deferred` are **not created/installed**
until their trigger condition is met and an ADR is accepted. Empty placeholder files (`.gitkeep`) are forbidden.

## Process
1. An agent or developer notices the need.
2. They write a draft under `docs/adr/proposed/NNNN-title.md` following `TEMPLATE.md` (the only ADR path agents may write).
3. A human reviews the draft; if accepted, moves it to `docs/adr/` and updates `architecture.json`.
4. Only then is the package/dependency added.
EOF

emit docs/adr/0003-job-queue-pg-boss.md <<'EOF'
# 0003. pg-boss for background jobs

- Status: accepted

## Decision
Use `pg-boss` on Postgres as the job queue: no extra infrastructure (Redis), and enqueueing can
happen in the same transaction as the business write. Redis-based queues (`bullmq` etc.) are
deferred until a measured throughput limit (see 0002).
EOF

emit docs/adr/proposed/README.md <<'EOF'
ADR **drafts** written by agents and developers go here. Nothing in this folder is accepted, and
`architecture.json` may not reference it.
EOF

# --- Agent instructions (CLAUDE.md block) ----------------------------------------------------
upsert_claude_md <<'EOF'
# Project rules

This block is protected by `.claude/hooks/guard.mjs` and `pnpm arch`. Anything outside it may be edited freely.

## Language
Chat with the user in the user's language. Everything else — code, comments, docs, ADRs, commit messages, PR text, log and error messages — is written in English.

## Commands
- `pnpm verify`: architecture, lint, typecheck and tests. **Work is done only when this passes.**
- `pnpm dev`: all apps. Postgres via `docker compose up -d`.
- `pnpm arch`: architecture check only.
- `pnpm add <pkg> --filter __SCOPE__/<target>`: add a dependency; the version is written to the catalog.

## Where code goes
| Need | Location |
|---|---|
| Business rule, calculation, value object | `packages/domain` |
| Request/response schema, validation | `packages/contracts` (Zod) |
| Table, migration, query helper | `packages/db` |
| Use case (domain + db orchestration) | `packages/core` |
| HTTP endpoint | `apps/api/src/app.ts` (validation + core call only) |
| Background job | `apps/worker/src/jobs/` (core call only) |
| UI | `apps/web` (API access via `src/lib/api.ts`) |

Dependency direction and package roles: `architecture.json` and `docs/adr/0001-package-boundaries.md`.

## Hard rules
1. **No new packages or folders.** Only the packages in `architecture.json` may exist under `apps/` and `packages/`.
2. **Deferred work stays deferred.** Packages and dependencies under `architecture.json > deferred` are not added before their trigger. If you think one is needed, **stop**, write a draft under `docs/adr/proposed/` following `docs/adr/TEMPLATE.md`, and ask the user.
3. **Protected files are not changed:** `architecture.json > protected_paths` and this block. Humans only.
4. Never silence checks: `@ts-ignore`, `@ts-nocheck`, `--no-verify` are forbidden. Every `biome-ignore` needs a reason.
5. Money is always the `Money` type from `domain` (`bigint` + currency); never `number`.
6. Relative imports include the `.ts` extension (`./foo.ts`).
7. No empty placeholder files/folders (`.gitkeep`, `export {}`). Write code when it is needed.
EOF

