#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Modern TypeScript monorepo scaffold with agent guardrails
#
#   ./scaffold-monorepo.sh <target-dir> [--scope @app] [--db-prefix app] [--no-install]
#
# Generates:
#   apps/{api,web,worker}  packages/{domain,contracts,db,core}
#   architecture.json      → allowed packages, dependency matrix, deferred packages
#   scripts/arch-check.mjs → enforces the matrix at package.json and import level
#   .claude/hooks          → blocks agents from protected files / undeclared packages / deferred deps
#   .githooks + CI         → same checks for every agent and human
# Idempotent: existing files are never touched; a marked rules block is added to CLAUDE.md once.
# Versions are resolved from npm at scaffold time (pnpm catalog).
# ---------------------------------------------------------------------------
set -euo pipefail

TARGET=""
SCOPE="@app"
DB_PREFIX=""
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    --db-prefix) DB_PREFIX="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done
[[ -n "$TARGET" ]] || { echo "Usage: $0 <target-dir> [--scope @app] [--no-install]" >&2; exit 1; }
[[ "$SCOPE" == @* ]] || { echo "--scope must start with '@'" >&2; exit 1; }
# Local Postgres database prefix (main checkout DB name; worktrees get <prefix>_wt_<key>).
[[ -n "$DB_PREFIX" ]] || DB_PREFIX="$(printf '%s' "${SCOPE#@}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' '_')"
[[ "$DB_PREFIX" =~ ^[a-z][a-z0-9_]{0,29}$ ]] || { echo "--db-prefix must match ^[a-z][a-z0-9_]{0,29}$" >&2; exit 1; }

WRITTEN=()
emit() { # usage: emit <path> <<'EOF' ... EOF  — skips existing files
  if [[ -e "$1" ]]; then
    echo "  = $1 (exists, skipped)"
    cat >/dev/null
    return 0
  fi
  mkdir -p "$(dirname "$1")"
  cat >"$1"
  WRITTEN+=("$1")
}

CLAUDE_BEGIN="<!-- scaffold:begin — managed by scaffold-monorepo.sh -->"
CLAUDE_END="<!-- scaffold:end -->"
upsert_claude_md() { # block from stdin; appended once, existing content preserved
  local block
  block="$(cat)"
  block="${block//__SCOPE__/$SCOPE}"
  if [[ -f CLAUDE.md ]] && grep -qF "<!-- scaffold:begin" CLAUDE.md; then
    echo "  = CLAUDE.md (scaffold block present, skipped)"
    return 0
  fi
  {
    if [[ -s CLAUDE.md ]]; then
      [[ "$(tail -c1 CLAUDE.md)" == "" ]] || printf '\n'
      printf '\n'
    fi
    printf '%s\n%s\n%s\n' "$CLAUDE_BEGIN" "$block" "$CLAUDE_END"
  } >>CLAUDE.md
  echo "  + CLAUDE.md (scaffold block appended)"
}

for bin in node pnpm git perl; do
  command -v "$bin" >/dev/null || { echo "Missing required tool: $bin" >&2; exit 1; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 24 )) || { echo "Node >= 24 required (found: $NODE_MAJOR)" >&2; exit 1; }
PNPM_VERSION="$(pnpm -v)"

mkdir -p "$TARGET"
cd "$TARGET"

# --- Versions (pnpm catalog) -----------------------------------------------------
CATALOG_YAML=""
if [[ ! -e pnpm-workspace.yaml ]]; then
  echo "→ Resolving latest versions..."
  CATALOG_PKGS=(
    typescript @biomejs/biome turbo vitest tsx tsdown
    zod hono @hono/node-server @hono/zod-validator
    drizzle-orm drizzle-kit postgres pg-boss
    react react-dom @types/react @types/react-dom vite @vitejs/plugin-react @tanstack/react-query
  )
  for p in "${CATALOG_PKGS[@]}"; do
    v="$(pnpm view "$p" version 2>/dev/null | tail -n1)"
    [[ -n "$v" ]] || { echo "Could not resolve version: $p" >&2; exit 1; }
    if [[ "$p" == typescript ]]; then spec="~$v"; else spec="^$v"; fi
    CATALOG_YAML+="  \"$p\": \"$spec\""$'\n'
  done
  CATALOG_YAML+="  \"@types/node\": \"^$NODE_MAJOR\""$'\n'
fi

# --- Root files ---------------------------------------------------------------------
emit pnpm-workspace.yaml <<EOF
packages:
  - "apps/*"
  - "packages/*"

# All external versions live here; package.json files only use "catalog:".
catalogMode: strict
catalog:
${CATALOG_YAML}
# Packages allowed to run install scripts
allowBuilds:
  esbuild: true
EOF

emit package.json <<'EOF'
{
  "name": "__SCOPE__/root",
  "private": true,
  "type": "module",
  "engines": { "node": ">=__NODE_MAJOR__" },
  "packageManager": "pnpm@__PNPM__",
  "scripts": {
    "prepare": "git config core.hooksPath .githooks || true",
    "dev": "turbo run dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome check --write .",
    "arch": "node scripts/arch-check.mjs",
    "verify": "pnpm arch && pnpm lint && pnpm typecheck && pnpm test",
    "db:generate": "pnpm --filter __SCOPE__/db generate",
    "db:migrate": "pnpm --filter __SCOPE__/db migrate",
    "worktree:setup": "node scripts/worktree.mjs setup",
    "worktree:teardown": "node scripts/worktree.mjs teardown",
    "worktree:info": "node scripts/worktree.mjs info",
    "worktree:gc": "node scripts/worktree.mjs gc"
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@types/node": "catalog:",
    "postgres": "catalog:",
    "turbo": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
EOF

emit turbo.json <<'EOF'
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^typecheck"] },
    "dev": { "cache": false, "persistent": true }
  }
}
EOF

emit tsconfig.base.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
EOF

emit biome.json <<'EOF'
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/migrations", "!**/*.md"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended",
      "suspicious": { "noExplicitAny": "error" },
      "style": { "noNonNullAssertion": "error" }
    }
  }
}
EOF

emit vitest.config.ts <<'EOF'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "scripts"],
    passWithNoTests: true,
  },
});
EOF

emit .gitignore <<'EOF'
node_modules
dist
.turbo
coverage
.env
.env.*
!.env.example
*.tsbuildinfo
EOF

emit .editorconfig <<'EOF'
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true
EOF

emit .nvmrc <<<"$NODE_MAJOR"

emit .env.example <<'EOF'
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://app:app@localhost:5432/app
EOF

emit compose.yaml <<'EOF'
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10
volumes:
  pgdata: {}
EOF

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
    "scripts/",
    "paseo.json",
    ".worktreeinclude",
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
- `pnpm worktree:setup` / `worktree:info`: per-worktree `.env` + database (Paseo runs setup automatically; see `paseo.json`). Never hard-code ports; services get `$PASEO_PORT`.
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

# --- Architecture check script -----------------------------------------------------------
emit scripts/arch-check.mjs <<'EOF'
#!/usr/bin/env node
// Enforces the contract in architecture.json. Dependency-free; does not need the TS compiler API.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const arch = JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8"));

/** sha256 of the CLAUDE.md scaffold block (markers included); null if missing. */
function claudeBlockHash() {
  const cb = arch.claude_md_block;
  const p = path.join(root, "CLAUDE.md");
  if (!cb || !existsSync(p)) return null;
  const text = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const b = text.indexOf(cb.begin);
  const e = b < 0 ? -1 : text.indexOf(cb.end, b);
  if (e < 0) return null;
  return createHash("sha256").update(text.slice(b, e + cb.end.length)).digest("hex");
}
// A human intentionally changed the block: `pnpm arch --claude-hash` → write it into architecture.json.
if (process.argv.includes("--claude-hash")) {
  console.log(claudeBlockHash() ?? "CLAUDE.md scaffold block not found");
  process.exit(0);
}

const { scope, packages } = arch;
const deferred = arch.deferred ?? [];
const testAllow = new Set(arch.test_allow ?? []);
const errors = [];
const err = (m) => errors.push(m);
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

const nameToDir = new Map(Object.keys(packages).map((d) => [`${scope}/${path.basename(d)}`, d]));
const deferredByPath = new Map(deferred.filter((d) => d.path).map((d) => [d.path, d]));
const forbiddenDeps = new Map(deferred.flatMap((d) => (d.deps ?? []).map((dep) => [dep, d])));
const hint = (d) =>
  `deferred "${d.name}". Trigger: ${d.trigger} If needed, write an ADR draft under docs/adr/proposed/ and ask a human.`;
const pkgNameOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".turbo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (readdirSync(p).length === 0) err(`${rel(p)}: empty folder (placeholders are forbidden)`);
      yield* walk(p);
    } else yield p;
  }
}

// 1) Only declared packages under apps/ and packages/
for (const group of ["apps", "packages"]) {
  const g = path.join(root, group);
  if (!existsSync(g)) continue;
  for (const e of readdirSync(g, { withFileTypes: true })) {
    const dir = `${group}/${e.name}`;
    if (packages[dir]) continue;
    const d = deferredByPath.get(dir);
    err(`${dir}: not declared in architecture.json — ${d ? hint(d) : "new packages require an accepted ADR."}`);
  }
}

// 2) Deferred dependencies must not appear anywhere (root + catalog included)
const depsOf = (pj) => ({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies, ...pj.optionalDependencies });
const rootPj = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
for (const dep of Object.keys(depsOf(rootPj))) {
  const d = forbiddenDeps.get(dep);
  if (d) err(`package.json → ${dep}: ${hint(d)}`);
}
const ws = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
for (const [dep, d] of forbiddenDeps) {
  const re = new RegExp(`^\\s+["']?${dep.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']?\\s*:`, "m");
  if (re.test(ws)) err(`pnpm-workspace.yaml catalog → ${dep}: ${hint(d)}`);
}

// 3) Per-package checks
const IMPORT_RE =
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

for (const [dir, spec] of Object.entries(packages)) {
  const abs = path.join(root, dir);
  const pjPath = path.join(abs, "package.json");
  if (!existsSync(pjPath)) {
    err(`${dir}: package.json missing`);
    continue;
  }
  if (!spec.adr || spec.adr.includes("/proposed/") || !existsSync(path.join(root, spec.adr)))
    err(`${dir}: missing or invalid accepted ADR reference (${spec.adr ?? "-"})`);

  const pj = JSON.parse(readFileSync(pjPath, "utf8"));
  const expected = `${scope}/${path.basename(dir)}`;
  if (pj.name !== expected) err(`${dir}: package name must be "${expected}" (found: ${pj.name})`);

  const mayDepend = new Set(spec.may_depend_on ?? []);
  const typeOnly = new Set(spec.type_only ?? []);
  const extAllow = spec.external_allow ? new Set(spec.external_allow) : null;

  for (const dep of Object.keys(depsOf(pj))) {
    const target = nameToDir.get(dep);
    if (target) {
      if (!mayDepend.has(target) && !typeOnly.has(target))
        err(`${dir} → ${dep}: dependency not allowed (allowed: ${[...mayDepend, ...typeOnly].join(", ") || "none"})`);
    } else if (dep.startsWith(`${scope}/`)) err(`${dir} → ${dep}: unknown workspace package`);
    else if (forbiddenDeps.has(dep)) err(`${dir} → ${dep}: ${hint(forbiddenDeps.get(dep))}`);
    else if (extAllow && !extAllow.has(dep) && !testAllow.has(dep))
      err(`${dir} → ${dep}: external dependency not in allow list (${[...extAllow].join(", ") || "none"})`);
  }

  for (const file of walk(abs)) {
    const r = rel(file);
    if (path.basename(file) === ".gitkeep") err(`${r}: placeholder files are forbidden`);
    if (!/\.(ts|tsx|mts|cts|js|mjs|jsx)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    if (/@ts-(ignore|nocheck)/.test(src)) err(`${r}: @ts-ignore / @ts-nocheck are forbidden`);
    if (/^\s*export\s*\{\s*\}\s*;?\s*$/.test(src)) err(`${r}: empty module (export {}) — placeholders are forbidden`);
    const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

    for (const m of src.matchAll(IMPORT_RE)) {
      const isType = Boolean(m[2]);
      const s = m[3] ?? m[4];
      if (!s) continue;
      if (s.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), s);
        if (!resolved.startsWith(abs + path.sep)) err(`${r}: relative import outside the package ("${s}")`);
        continue;
      }
      const name = pkgNameOf(s);
      if (name.startsWith(`${scope}/`)) {
        const target = nameToDir.get(name);
        if (!target) err(`${r}: unknown workspace package "${name}"`);
        else if (target === dir) err(`${r}: a package must not import itself by name ("${s}")`);
        else if (typeOnly.has(target) && !isType) err(`${r}: "${name}" may only be imported with \`import type\``);
        else if (!mayDepend.has(target) && !typeOnly.has(target)) err(`${r}: import of "${name}" is not allowed`);
        continue;
      }
      if (forbiddenDeps.has(name)) {
        err(`${r}: "${name}" ${hint(forbiddenDeps.get(name))}`);
        continue;
      }
      if (extAllow && !(isTest && testAllow.has(name))) {
        const ok = s.startsWith("node:") ? extAllow.has("node:*") : extAllow.has(name);
        if (!ok) err(`${r}: import of "${s}" is not allowed (${dir} external allow list: ${[...extAllow].join(", ") || "none"})`);
      }
    }
  }
}

// 4) The CLAUDE.md scaffold block must exist and be unchanged (outside the block is free)
if (arch.claude_md_block) {
  const h = claudeBlockHash();
  if (!h) err("CLAUDE.md: scaffold block missing");
  else if (h !== arch.claude_md_block.sha256)
    err("CLAUDE.md: scaffold block was modified. Humans only; if intentional, write the output of `pnpm arch --claude-hash` into architecture.json > claude_md_block.sha256.");
}

if (errors.length) {
  console.error(`✗ Architecture check failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  console.error("\nRules: CLAUDE.md, architecture.json, docs/adr/");
  process.exit(1);
}
console.log(`✓ Architecture check passed (${Object.keys(packages).length} packages)`);
EOF

# --- Claude Code hooks -------------------------------------------------------------------
emit .claude/settings.json <<'EOF'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.mjs" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop-check.mjs" }]
      }
    ]
  }
}
EOF

emit .claude/hooks/guard.mjs <<'EOF'
#!/usr/bin/env node
// PreToolUse: blocks writes to protected files, undeclared packages, deferred dependencies and
// hook bypass attempts (exit 2 → the tool call is cancelled and the message goes to the agent).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const arch = JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8"));
const allowed = new Set(Object.keys(arch.packages));
const deferred = arch.deferred ?? [];
const protectedPaths = arch.protected_paths ?? [];
const exceptions = arch.agent_writable_exceptions ?? [];

const block = (msg) => {
  process.stderr.write(`⛔ ${msg}\nRules: CLAUDE.md and architecture.json.\n`);
  process.exit(2);
};
const hint = (d) =>
  `This is deferred "${d.name}" (trigger: ${d.trigger}). If you think it is needed, stop, write an ADR draft under docs/adr/proposed/ and ask the user.`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isProtected = (r) =>
  !exceptions.some((e) => r.startsWith(e)) &&
  protectedPaths.some((p) => (p.endsWith("/") ? r.startsWith(p) : r === p));

function checkPath(r) {
  if (r.startsWith("..") || path.isAbsolute(r)) return;
  if (isProtected(r))
    block(`${r} is protected; only humans may change it. If a change is needed, write an ADR draft under docs/adr/proposed/ and ask the user.`);
  const m = r.match(/^(apps|packages)\/([^/]+)/);
  if (m && !allowed.has(`${m[1]}/${m[2]}`)) {
    const dir = `${m[1]}/${m[2]}`;
    const d = deferred.find((x) => x.path === dir);
    block(`${dir} is not a package declared in architecture.json. ${d ? hint(d) : "Adding a package requires an accepted ADR."}`);
  }
}

const tool = input.tool_name;
const ti = input.tool_input ?? {};

/** CLAUDE.md: blocks edits touching the scaffold block; outside the block is free. */
function checkClaudeMd() {
  const cb = arch.claude_md_block;
  const p = path.join(root, "CLAUDE.md");
  if (!cb || !existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const b = text.indexOf(cb.begin);
  const e = b < 0 ? -1 : text.indexOf(cb.end, b);
  if (e < 0) return;
  const end = e + cb.end.length;
  const msg = "The scaffold block in CLAUDE.md is protected; edit only outside the block.";
  if (tool === "Write") {
    if (!String(ti.content ?? "").includes(text.slice(b, end))) block(msg);
    return;
  }
  const edits = tool === "MultiEdit" ? (ti.edits ?? []) : [ti];
  for (const ed of edits) {
    const old = String(ed.old_string ?? "");
    if (!old) continue;
    for (let i = text.indexOf(old); i >= 0; i = text.indexOf(old, i + 1))
      if (i < end && i + old.length > b) block(msg);
  }
}

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const fp = ti.file_path ?? ti.notebook_path;
  if (fp) {
    const r = path.relative(root, path.resolve(root, fp)).split(path.sep).join("/");
    checkPath(r);
    if (r === "CLAUDE.md") checkClaudeMd();
  }
}

if (tool === "Bash") {
  const cmd = String(ti.command ?? "");
  // Path-like tokens resolved against the project root; paths outside the project are ignored.
  const home = process.env.HOME ?? "~";
  const relTokens = [...cmd.matchAll(/[^\s"'<>|;&()]+/g)]
    .map((m) => m[0].replace(/^~(?=\/)/, home))
    .map((t) => path.relative(root, path.resolve(root, t)).split(path.sep).join("/"))
    .filter((r) => r && !r.startsWith("..") && !path.isAbsolute(r));
  const touchesProtected = relTokens.some(
    (r) => isProtected(r) || protectedPaths.some((p) => p.endsWith("/") && r === p.slice(0, -1)),
  );

  if (
    relTokens.includes("CLAUDE.md") &&
    (/\b(sed\s+-i|perl\s+-p?i|rm|mv|cp|truncate)\b/.test(cmd) ||
      /(^|[^>])>\s*["']?\S*CLAUDE\.md/.test(cmd) ||
      /\btee\s+(?!-a)\S*CLAUDE\.md/.test(cmd))
  )
    block("CLAUDE.md must not be modified via Bash; use the Edit tool, outside the scaffold block only.");
  if (/--no-verify\b/.test(cmd) || /\bgit\s+commit\b[^|;&]*\s-n\b/.test(cmd))
    block("Skipping git hooks is forbidden (--no-verify).");
  if (/core\.hooksPath/.test(cmd) && !/\.githooks/.test(cmd)) block("Changing the git hooks path is forbidden.");
  if (/\bgit\s+(clean|checkout\s+--|restore|rm)\b/.test(cmd) && touchesProtected)
    block("Command touches a protected path via git; only humans may change it.");

  if (/\b(pnpm|npm|yarn|bun)\s+(add|install|i|update|up)\b/.test(cmd)) {
    for (const d of deferred)
      for (const dep of d.deps ?? [])
        if (new RegExp(`(^|[\\s"'])${esc(dep)}(@[^\\s"']*)?(?=$|[\\s"'])`).test(cmd))
          block(`"${dep}" cannot be installed. ${hint(d)}`);
  }

  const redirects = cmd.replace(/\d*>&\d/g, "").replace(/\d*>\s*\/dev\/null/g, "");
  const writes = /\b(mkdir|touch|cp|mv|rm|tee|truncate|ln|install)\b|\bsed\s+-i|\bperl\s+-p?i|>/.test(redirects);
  if (writes) {
    if (touchesProtected) block("Command touches a protected path; only humans may change it.");
    for (const r of relTokens) if (/^(apps|packages)\/[^/]+/.test(r)) checkPath(r);
  }
}

process.exit(0);
EOF

emit .claude/hooks/stop-check.mjs <<'EOF'
#!/usr/bin/env node
// Stop: architecture + lint checks must pass before the agent finishes (exit 2 → agent continues).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active) process.exit(0); // avoid infinite loops
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8" });

const checks = [["architecture", run(process.execPath, ["scripts/arch-check.mjs"])]];
const biome = path.join(root, "node_modules", ".bin", "biome");
if (existsSync(biome)) checks.push(["lint", run(biome, ["check", "."])]);

const failed = checks.filter(([, r]) => r.status !== 0);
if (failed.length) {
  const out = failed.map(([n, r]) => `## ${n}\n${r.stdout ?? ""}${r.stderr ?? ""}`).join("\n");
  process.stderr.write(`Fix these checks before finishing (pnpm verify):\n${out.slice(-6000)}`);
  process.exit(2);
}
process.exit(0);
EOF

# --- Git hook + CI -----------------------------------------------------------------------
emit .githooks/pre-commit <<'EOF'
#!/bin/sh
set -e
pnpm -s arch
pnpm -s lint
EOF
chmod +x .githooks/pre-commit scripts/arch-check.mjs .claude/hooks/*.mjs

emit .github/workflows/ci.yml <<'EOF'
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
      - run: pnpm build
EOF

emit .github/CODEOWNERS <<'EOF'
# Architecture contract files require human review. Replace OWNER with a GitHub user/team
# and uncomment the lines below.
# /architecture.json        OWNER
# /CLAUDE.md                OWNER
# /docs/adr/                OWNER
# /scripts/arch-check.mjs   OWNER
# /.claude/                 OWNER
# /.github/                 OWNER
EOF

# --- Package helper ------------------------------------------------------------------------
lib_pkg() { # $1=dir  $2=deps-json  $3=devdeps-json  $4=extra-scripts-json
  local name deps devdeps scripts
  name="$(basename "$1")"
  deps="${2:-}"; [[ -n "$deps" ]] || deps="{}"
  devdeps="${3:-}"; [[ -n "$devdeps" ]] || devdeps="{}"
  scripts='"typecheck": "tsc -p ."'
  [[ -z "${4:-}" ]] || scripts+=", $4"
  emit "$1/package.json" <<EOF
{
  "name": "__SCOPE__/$name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { $scripts },
  "dependencies": $deps,
  "devDependencies": $devdeps
}
EOF
  emit "$1/tsconfig.json" <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "*.config.ts"]
}
EOF
}

# --- packages/domain ---------------------------------------------------------------------
lib_pkg packages/domain
emit packages/domain/src/index.ts <<'EOF'
export * from "./money/money.ts";
EOF
emit packages/domain/src/money/money.ts <<'EOF'
/** Money: amount in minor units (cents) as bigint + ISO 4217 currency. Never use number. */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  override name = "CurrencyMismatchError";
}

const digitsCache = new Map<string, number>();

/** Number of minor-unit digits for a currency (USD: 2, JPY: 0, KWD: 3). */
export function minorDigits(currency: string): number {
  let digits = digitsCache.get(currency);
  if (digits === undefined) {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    digitsCache.set(currency, digits);
  }
  return digits;
}

export function money(amount: bigint, currency: string): Money {
  const code = currency.toUpperCase();
  minorDigits(code); // throws RangeError for an invalid currency
  return { amount, currency: code };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(`Cannot add ${a.currency} and ${b.currency}`);
  }
  return money(a.amount + b.amount, a.currency);
}

/** Lossless decimal representation: 12345n USD → "123.45" */
export function toDecimalString(m: Money): string {
  const digits = minorDigits(m.currency);
  const negative = m.amount < 0n;
  const abs = (negative ? -m.amount : m.amount).toString().padStart(digits + 1, "0");
  const whole = digits === 0 ? abs : abs.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${abs.slice(-digits)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export function format(m: Money, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(
    toDecimalString(m) as `${number}`,
  );
}
EOF
emit packages/domain/src/money/money.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { add, CurrencyMismatchError, format, money, toDecimalString } from "./money.ts";

describe("money", () => {
  it("adds amounts in the same currency", () => {
    expect(add(money(10n, "USD"), money(20n, "usd"))).toEqual(money(30n, "USD"));
  });

  it("refuses to add different currencies", () => {
    expect(() => add(money(1n, "USD"), money(1n, "EUR"))).toThrow(CurrencyMismatchError);
  });

  it("respects the currency's minor digits", () => {
    expect(toDecimalString(money(12345n, "USD"))).toBe("123.45");
    expect(toDecimalString(money(12345n, "JPY"))).toBe("12345");
    expect(toDecimalString(money(12345n, "KWD"))).toBe("12.345");
    expect(toDecimalString(money(-5n, "USD"))).toBe("-0.05");
  });

  it("does not lose precision above 2^53", () => {
    expect(toDecimalString(money(9007199254740993n, "USD"))).toBe("90071992547409.93");
  });

  it("formats for a locale", () => {
    expect(format(money(123456n, "USD"), "en-US")).toBe("$1,234.56");
  });
});
EOF

# --- packages/contracts ------------------------------------------------------------------
lib_pkg packages/contracts '{ "zod": "catalog:" }'
emit packages/contracts/src/index.ts <<'EOF'
import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const FormatPriceRequest = z.object({
  /** Integer amount in minor units, as a string (JSON cannot carry bigint). */
  amount: z.string().regex(/^-?\d+$/, "must be an integer"),
  currency: z.string().length(3),
  locale: z.string().min(2).default("en-US"),
});
export type FormatPriceRequest = z.infer<typeof FormatPriceRequest>;

export const FormatPriceResponse = z.object({ formatted: z.string() });
export type FormatPriceResponse = z.infer<typeof FormatPriceResponse>;
EOF

# --- packages/db -------------------------------------------------------------------------
lib_pkg packages/db \
  '{ "drizzle-orm": "catalog:", "postgres": "catalog:" }' \
  '{ "drizzle-kit": "catalog:" }' \
  '"generate": "drizzle-kit generate", "migrate": "drizzle-kit migrate"'
emit packages/db/drizzle.config.ts <<'EOF'
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
});
EOF
emit packages/db/src/schema/index.ts <<'EOF'
// Tables live in this folder, one file per table, re-exported here.
// Example: export * from "./products.ts";
export const schemaVersion = 1;
EOF
emit packages/db/src/index.ts <<'EOF'
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

export { schema };
EOF

# --- packages/core -----------------------------------------------------------------------
lib_pkg packages/core \
  '{ "__SCOPE__/contracts": "workspace:*", "__SCOPE__/db": "workspace:*", "__SCOPE__/domain": "workspace:*" }'
emit packages/core/src/index.ts <<'EOF'
export { formatPrice } from "./queries/format-price.ts";
export { checkHealth } from "./queries/health.ts";
EOF
emit packages/core/src/queries/health.ts <<'EOF'
import type { HealthResponse } from "__SCOPE__/contracts";
import { type Db, ping } from "__SCOPE__/db";

export async function checkHealth(db: Db): Promise<HealthResponse> {
  try {
    await ping(db);
    return { status: "ok", db: "up" };
  } catch {
    return { status: "degraded", db: "down" };
  }
}
EOF
emit packages/core/src/queries/format-price.ts <<'EOF'
import type { FormatPriceRequest, FormatPriceResponse } from "__SCOPE__/contracts";
import { format, money } from "__SCOPE__/domain";

export function formatPrice(input: FormatPriceRequest): FormatPriceResponse {
  return { formatted: format(money(BigInt(input.amount), input.currency), input.locale) };
}
EOF

# --- Node app helper ---------------------------------------------------------------------
node_app_files() { # $1=dir  $2=deps-json  $3=entry
  local name; name="$(basename "$1")"
  emit "$1/package.json" <<EOF
{
  "name": "__SCOPE__/$name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/$3.ts",
    "build": "tsdown",
    "start": "node --env-file-if-exists=../../.env dist/$3.mjs",
    "typecheck": "tsc -p ."
  },
  "dependencies": $2,
  "devDependencies": { "tsdown": "catalog:", "tsx": "catalog:" }
}
EOF
  emit "$1/tsconfig.json" <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "*.config.ts"]
}
EOF
  emit "$1/tsdown.config.ts" <<EOF
import { defineConfig } from "tsdown";

// Workspace packages are consumed as source, so they are bundled into the output.
export default defineConfig({
  entry: ["src/$3.ts"],
  platform: "node",
  format: "esm",
  outDir: "dist",
  noExternal: [/^__SCOPE_RE__\\//],
});
EOF
  emit "$1/src/env.ts" <<'EOF'
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
});

export type Env = z.infer<typeof Env>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
EOF
}

# --- apps/api ----------------------------------------------------------------------------
node_app_files apps/api '{
    "__SCOPE__/contracts": "workspace:*",
    "__SCOPE__/core": "workspace:*",
    "__SCOPE__/db": "workspace:*",
    "@hono/node-server": "catalog:",
    "@hono/zod-validator": "catalog:",
    "hono": "catalog:",
    "zod": "catalog:"
  }' server

emit apps/api/src/index.ts <<'EOF'
// The web app uses this type only via `import type` (hc<AppType>).
export type { AppType } from "./app.ts";
EOF
emit apps/api/src/app.ts <<'EOF'
import { FormatPriceRequest } from "__SCOPE__/contracts";
import { checkHealth, formatPrice } from "__SCOPE__/core";
import type { Db } from "__SCOPE__/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

export interface AppDeps {
  db: Db;
}

/** HTTP layer: validation + core calls only. No business rules here. */
export function createApp({ db }: AppDeps) {
  return new Hono()
    .basePath("/api")
    .get("/health", async (c) => c.json(await checkHealth(db)))
    .post("/format-price", zValidator("json", FormatPriceRequest), (c) =>
      c.json(formatPrice(c.req.valid("json"))),
    );
}

export type AppType = ReturnType<typeof createApp>;
EOF
emit apps/api/src/server.ts <<'EOF'
import { createDb } from "__SCOPE__/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = createApp({ db });

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`api → http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void db.$client.end({ timeout: 5 }).finally(() => process.exit(0));
  });
}
EOF
emit apps/api/src/app.test.ts <<'EOF'
import type { Db } from "__SCOPE__/db";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const downDb = {
  execute: () => Promise.reject(new Error("no connection")),
} as unknown as Db;

describe("api", () => {
  const app = createApp({ db: downDb });

  it("reports degraded when the DB is unreachable", async () => {
    const res = await app.request("/api/health");
    expect(await res.json()).toEqual({ status: "degraded", db: "down" });
  });

  it("formats a price", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "123456", currency: "USD", locale: "en-US" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ formatted: "$1,234.56" });
  });

  it("rejects invalid input via the contracts schema", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "12.5", currency: "USD" }),
    });
    expect(res.status).toBe(400);
  });
});
EOF

# --- apps/worker -------------------------------------------------------------------------
node_app_files apps/worker '{
    "__SCOPE__/core": "workspace:*",
    "__SCOPE__/db": "workspace:*",
    "pg-boss": "catalog:",
    "zod": "catalog:"
  }' worker
emit apps/worker/src/index.ts <<'EOF'
export { jobs } from "./jobs/index.ts";
EOF
emit apps/worker/src/jobs/index.ts <<'EOF'
import { healthcheck } from "./healthcheck.ts";

/** Each job: queue name + optional cron + handler. Handlers only call core. */
export const jobs = [healthcheck];
EOF
emit apps/worker/src/jobs/healthcheck.ts <<'EOF'
import { checkHealth } from "__SCOPE__/core";
import type { Db } from "__SCOPE__/db";

export const healthcheck = {
  name: "healthcheck",
  cron: "*/5 * * * *",
  async handle(db: Db): Promise<void> {
    const result = await checkHealth(db);
    console.log("healthcheck", result);
  },
};
EOF
emit apps/worker/src/worker.ts <<'EOF'
import { createDb } from "__SCOPE__/db";
import { PgBoss } from "pg-boss";
import { loadEnv } from "./env.ts";
import { jobs } from "./jobs/index.ts";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const boss = new PgBoss(env.DATABASE_URL);
boss.on("error", (error) => console.error("pg-boss", error));

await boss.start();
for (const job of jobs) {
  await boss.createQueue(job.name);
  await boss.work(job.name, async () => job.handle(db));
  if (job.cron) await boss.schedule(job.name, job.cron);
}
console.log(`worker → listening on ${jobs.length} queue(s)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void boss
      .stop()
      .then(() => db.$client.end({ timeout: 5 }))
      .finally(() => process.exit(0));
  });
}
EOF

# --- apps/web ----------------------------------------------------------------------------
emit apps/web/package.json <<'EOF'
{
  "name": "__SCOPE__/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "__SCOPE__/contracts": "workspace:*",
    "__SCOPE__/domain": "workspace:*",
    "@tanstack/react-query": "catalog:",
    "hono": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:"
  },
  "devDependencies": {
    "__SCOPE__/api": "workspace:*",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "@vitejs/plugin-react": "catalog:",
    "vite": "catalog:"
  }
}
EOF
emit apps/web/tsconfig.json <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    // "node": AppType is inferred from the api source, which needs Node types.
    "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
EOF
emit apps/web/vite.config.ts <<'EOF'
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // API_URL is set per worktree by paseo.json; defaults to the local API.
  server: { proxy: { "/api": process.env.API_URL ?? "http://localhost:3000" } },
});
EOF
emit apps/web/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
emit apps/web/src/lib/api.ts <<'EOF'
import type { AppType } from "__SCOPE__/api";
import { hc } from "hono/client";

/** Single entry point to the API. Endpoints and types are inferred from the Hono app. */
export const api = hc<AppType>("/").api;
EOF
emit apps/web/src/main.tsx <<'EOF'
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib/api.ts";

function Health() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => (await api.health.$get()).json(),
  });
  if (health.isPending) return <p>Loading…</p>;
  if (health.isError) return <p>API unreachable.</p>;
  return (
    <p>
      API: {health.data.status} · DB: {health.data.db}
    </p>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <h1>Hello</h1>
      <Health />
    </QueryClientProvider>
  </StrictMode>,
);
EOF


# --- Paseo + per-worktree isolation ----------------------------------------------------------
# Every git worktree (Paseo, Claude Code, manual) gets its own Postgres database. pg-boss keeps
# its queue in the same database, so jobs are isolated too. HTTP ports come from Paseo.
emit paseo.json <<'EOF'
{
  "worktree": {
    "setup": [
      "command -v pnpm >/dev/null || corepack enable --install-directory \"$HOME/.local/bin\" pnpm",
      "pnpm install --frozen-lockfile",
      "pnpm worktree:setup"
    ],
    "teardown": "pnpm worktree:teardown || true",
    "servicePorts": { "range": "4100-4999" }
  },
  "scripts": {
    "api": {
      "type": "service",
      "command": "PORT=$PASEO_PORT pnpm --filter __SCOPE__/api dev"
    },
    "web": {
      "type": "service",
      "command": "API_URL=http://127.0.0.1:$PASEO_SERVICE_API_PORT pnpm --filter __SCOPE__/web dev --host $HOST --port $PASEO_PORT --strictPort"
    },
    "worker": {
      "type": "service",
      "command": "pnpm --filter __SCOPE__/worker dev"
    },
    "test": { "command": "pnpm test" },
    "verify": { "command": "pnpm verify" },
    "db:migrate": { "command": "pnpm db:migrate" },
    "worktree:info": { "command": "pnpm worktree:info" }
  }
}
EOF

emit .worktreeinclude <<'EOF'
.env
EOF

emit scripts/worktree-lib.mjs <<'EOF'
// Pure helpers for scripts/worktree.mjs (unit-tested in worktree-lib.test.mjs).
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { parseEnv } from "node:util";

/** `<slug>_<sha1(path)[:6]>`; slug = lowercased basename, `[^a-z0-9]` → `_`, max 20 chars. */
export function worktreeKey(worktreePath) {
  const slug = basename(worktreePath)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 20);
  const hash = createHash("sha1").update(worktreePath).digest("hex").slice(0, 6);
  return `${slug}_${hash}`;
}

/** Database name for the main checkout (`key === null`) or a worktree. */
export function databaseName(prefix, key) {
  return key === null ? prefix : `${prefix}_wt_${key}`;
}

/** `url` with its database name replaced; `undefined` passes through. */
export function withDatabase(url, database) {
  if (url === undefined || url === "") return undefined;
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Database name from a connection URL. */
export function databaseOf(url) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

export function setLine(text, key, value) {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (line.test(text)) return text.replace(line, `${key}=${value}`);
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${key}=${value}\n`;
}

/**
 * Points DATABASE_URL and WORKTREE_KEY at this checkout. A key is rewritten only while it is
 * missing or still equals the source checkout's value, so deliberate edits survive re-runs.
 */
export function rewriteIsolatedKeys(current, source, database, key) {
  const now = parseEnv(current);
  const src = parseEnv(source);
  const targets = {
    DATABASE_URL: withDatabase(now.DATABASE_URL ?? src.DATABASE_URL, database),
    WORKTREE_KEY: key ?? "",
  };
  let text = current;
  for (const [name, value] of Object.entries(targets)) {
    if (value === undefined) continue;
    if (now[name] === undefined || now[name] === src[name]) text = setLine(text, name, value);
  }
  return text;
}

/** Fills each listed key that is empty or still a `change-me` placeholder with 32 random bytes (hex). */
export function ensureSecrets(text, names) {
  const env = parseEnv(text);
  let result = text;
  for (const name of names) {
    const value = (env[name] ?? "").trim();
    if (value === "" || value.startsWith("change-me")) {
      result = setLine(result, name, randomBytes(32).toString("hex"));
    }
  }
  return result;
}
EOF

emit scripts/worktree-lib.test.mjs <<'EOF'
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  databaseName,
  ensureSecrets,
  rewriteIsolatedKeys,
  withDatabase,
  worktreeKey,
} from "./worktree-lib.mjs";

describe("worktree-lib", () => {
  it("derives a stable, sanitized key from the worktree path", () => {
    const key = worktreeKey("/home/me/.paseo/worktrees/abc/Icky-Emu");
    expect(key).toMatch(/^icky_emu_[0-9a-f]{6}$/);
    expect(worktreeKey("/home/me/.paseo/worktrees/abc/Icky-Emu")).toBe(key);
    expect(worktreeKey("/other/Icky-Emu")).not.toBe(key);
  });

  it("names the main and worktree databases", () => {
    expect(databaseName("app", null)).toBe("app");
    expect(databaseName("app", "icky_emu_3f9a1c")).toBe("app_wt_icky_emu_3f9a1c");
  });

  it("replaces only the database in a URL", () => {
    expect(withDatabase("postgres://u:p@localhost:5432/app", "app_wt_k")).toBe(
      "postgres://u:p@localhost:5432/app_wt_k",
    );
  });

  it("rewrites isolated keys but keeps deliberate edits", () => {
    const source = "DATABASE_URL=postgres://u:p@h:5432/app\nAPI_KEY=secret\n";
    const fresh = parseEnv(rewriteIsolatedKeys(source, source, "app_wt_k", "k"));
    expect(fresh.DATABASE_URL).toBe("postgres://u:p@h:5432/app_wt_k");
    expect(fresh.WORKTREE_KEY).toBe("k");
    expect(fresh.API_KEY).toBe("secret");

    const edited = "DATABASE_URL=postgres://u:p@h:5432/custom\n";
    expect(parseEnv(rewriteIsolatedKeys(edited, source, "app_wt_k", "k")).DATABASE_URL).toBe(
      "postgres://u:p@h:5432/custom",
    );
  });

  it("fills empty and placeholder secrets only", () => {
    const text = "A=\nB=change-me-please\nC=keep\n";
    const env = parseEnv(ensureSecrets(text, ["A", "B", "C", "D"]));
    expect(env.A).toMatch(/^[0-9a-f]{64}$/);
    expect(env.B).toMatch(/^[0-9a-f]{64}$/);
    expect(env.C).toBe("keep");
    expect(env.D).toMatch(/^[0-9a-f]{64}$/);
  });
});
EOF

emit scripts/worktree.mjs <<'EOF'
#!/usr/bin/env node
/**
 * Per-worktree isolation on a shared local Postgres (see docs/adr/0004-worktree-isolation.md).
 *   pnpm worktree:setup     .env + database + migrations for this checkout (idempotent)
 *   pnpm worktree:teardown  drop this worktree's database (never the main checkout's; always exits 0)
 *   pnpm worktree:info      print the key and resource names
 *   pnpm worktree:gc [--yes] drop databases whose worktree folder no longer exists
 * Works in Paseo worktrees, Claude Code worktrees and plain `git worktree add` checkouts.
 * Prints resource names only, never secret values.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";
import {
  databaseName,
  databaseOf,
  ensureSecrets,
  rewriteIsolatedKeys,
  withDatabase,
  worktreeKey,
} from "./worktree-lib.mjs";

/** Every local database of this project starts with this prefix. */
const PREFIX = "__DB_PREFIX__";
/** .env keys generated per machine when empty or still a `change-me` placeholder. */
const GENERATED_SECRETS = [];
const DB_PACKAGE = "__SCOPE__/db";
const COMMENT_PREFIX = "worktree:";

const log = (message) => console.log(`worktree: ${message}`);
const warn = (message) => console.warn(`worktree: WARNING: ${message}`);
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const toplevel = realpathSync(git("rev-parse", "--show-toplevel"));
const commonDir = realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
const isMain = commonDir === join(toplevel, ".git");
const mainCheckout = dirname(commonDir);
const key = isMain ? null : worktreeKey(toplevel);
const database = databaseName(PREFIX, key);
const envPath = join(toplevel, ".env");

const readEnv = () => (existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {});

function adminSql(env) {
  const url = withDatabase(env.DATABASE_URL, "postgres");
  if (!url) throw new Error("DATABASE_URL is missing from .env");
  return postgres(url, { max: 1, onnotice: () => {} });
}

/** Where a missing .env is copied from, and what "unchanged" isolated values are compared to. */
function sourceEnvPath() {
  const candidates = [
    process.env.PASEO_SOURCE_CHECKOUT_PATH && join(process.env.PASEO_SOURCE_CHECKOUT_PATH, ".env"),
    join(mainCheckout, ".env"),
    join(toplevel, ".env.example"),
  ];
  for (const candidate of candidates) {
    if (candidate && candidate !== envPath && existsSync(candidate)) return candidate;
  }
  throw new Error("no .env source found (expected .env.example at least)");
}

/** mkdir-based lock in the shared git dir so concurrent setups (Paseo + hooks) do not race. */
async function withLock(fn) {
  const lock = join(commonDir, "worktree-setup.lock");
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const stale = existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10 * 60_000;
      if (stale) rmSync(lock, { recursive: true, force: true });
      else if (attempt > 120) throw new Error(`could not acquire ${lock}`);
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function setup() {
  const source = sourceEnvPath();
  if (!existsSync(envPath)) {
    copyFileSync(source, envPath);
    log(`.env copied from ${source}`);
  }
  const current = readFileSync(envPath, "utf8");
  const next = ensureSecrets(
    rewriteIsolatedKeys(current, readFileSync(source, "utf8"), database, key),
    GENERATED_SECRETS,
  );
  if (next !== current) writeFileSync(envPath, next);
  chmodSync(envPath, 0o600);
  const env = readEnv();

  const sql = adminSql(env);
  try {
    const [exists] = await sql`select 1 from pg_database where datname = ${database}`;
    if (!exists) {
      await sql`create database ${sql(database)}`;
      log(`created database ${database}`);
    }
    const comment = `${COMMENT_PREFIX}${toplevel}`.replaceAll("'", "''");
    await sql.unsafe(`comment on database "${database}" is '${comment}'`);
  } finally {
    await sql.end();
  }

  if (existsSync(join(toplevel, "packages", "db", "migrations"))) {
    const result = spawnSync("pnpm", ["--silent", "--filter", DB_PACKAGE, "migrate"], {
      cwd: toplevel,
      env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status !== 0) throw new Error(`migrations failed on ${database}`);
    log(`${database}: migrated`);
  } else {
    log(`${database}: no migrations yet`);
  }
  info();
}

async function teardown() {
  if (key === null) return warn("refusing to tear down the main checkout");
  const env = readEnv();
  const protectedDbs = new Set([PREFIX]);
  const sourceEnv = process.env.PASEO_SOURCE_CHECKOUT_PATH
    ? join(process.env.PASEO_SOURCE_CHECKOUT_PATH, ".env")
    : join(mainCheckout, ".env");
  if (existsSync(sourceEnv)) {
    const url = parseEnv(readFileSync(sourceEnv, "utf8")).DATABASE_URL;
    if (url) protectedDbs.add(databaseOf(url));
  }
  if (!database.startsWith(`${PREFIX}_wt_`) || protectedDbs.has(database)) {
    return warn(`refusing: ${database} belongs to the main or source checkout`);
  }
  const sql = adminSql(env);
  try {
    await sql`drop database if exists ${sql(database)} with (force)`;
    log(`dropped database ${database} (if it existed)`);
  } finally {
    await sql.end();
  }
}

async function gc(confirmed) {
  const env = readEnv();
  const sql = adminSql(env);
  try {
    const rows = await sql`
      select datname, shobj_description(oid, 'pg_database') as comment
      from pg_database where datname like ${`${PREFIX}\\_wt\\_%`}`;
    const orphans = rows.filter(
      (r) => r.comment?.startsWith(COMMENT_PREFIX) && !existsSync(r.comment.slice(COMMENT_PREFIX.length)),
    );
    if (orphans.length === 0) return log("no orphaned worktree databases");
    for (const r of orphans) log(`orphaned: ${r.datname} (${r.comment.slice(COMMENT_PREFIX.length)} is gone)`);
    if (!confirmed) return log("re-run with --yes to drop them");
    for (const r of orphans) {
      await sql`drop database if exists ${sql(r.datname)} with (force)`;
      log(`dropped database ${r.datname}`);
    }
  } finally {
    await sql.end();
  }
}

function info() {
  const lines = [
    ["checkout", isMain ? `${toplevel} (main)` : toplevel],
    ["key", key ?? "(main checkout)"],
    ["database", database],
    [".env", existsSync(envPath) ? envPath : "(missing; run pnpm worktree:setup)"],
  ];
  for (const [label, value] of lines) console.log(`${`${label}:`.padEnd(10)} ${value}`);
}

const [command, ...flags] = process.argv.slice(2);
switch (command) {
  case "setup":
    await withLock(setup);
    break;
  case "teardown":
    try {
      await teardown();
    } catch (error) {
      warn(errorText(error));
    }
    process.exit(0);
    break;
  case "gc":
    await gc(flags.includes("--yes"));
    break;
  case "info":
    info();
    break;
  default:
    console.error("usage: worktree <setup|teardown|info|gc [--yes]>");
    process.exit(2);
}
EOF
chmod +x scripts/worktree.mjs

emit docs/adr/0004-worktree-isolation.md <<'EOF'
# 0004. Per-worktree isolation (Paseo)

- Status: accepted

## Context
Agents and developers work in parallel git worktrees (Paseo, Claude Code, `git worktree add`).
Sharing one database or fixed ports between them causes collisions.

## Decision
- One shared local Postgres; isolation by name. The main checkout uses `__DB_PREFIX__`, every
  worktree `__DB_PREFIX___wt_<key>` (`<key>` = sanitized folder name + sha1 of the path).
  pg-boss stores its queue in the same database, so jobs are isolated too.
- `scripts/worktree.mjs` (`pnpm worktree:setup|teardown|info|gc`) writes `.env` (copied from the
  source checkout, only isolated keys rewritten, placeholder secrets generated), creates the
  database, runs migrations, and drops it again on teardown. It never touches the main checkout's
  database; teardown always exits 0.
- `paseo.json` runs setup/teardown and defines `api`, `web`, `worker` as services. Ports are
  assigned by Paseo (`servicePorts.range` 4100-4999) and never hard-coded; the web dev server
  proxies `/api` to `API_URL`. `.worktreeinclude` copies `.env` into new worktrees.
- Paseo reads `paseo.json` from the base branch: changes take effect after merging to main.

## Consequences
Worktrees removed outside Paseo leave databases behind; `pnpm worktree:gc --yes` drops them.
EOF
# --- Fill placeholders (only in files created by this run) ----------------------------------------
if (( ${#WRITTEN[@]} )); then
  SCOPE="$SCOPE" DB_PREFIX="$DB_PREFIX" NODE_MAJOR="$NODE_MAJOR" PNPM_VERSION="$PNPM_VERSION" perl -pi -e '
    s/__DB_PREFIX__/$ENV{DB_PREFIX}/g;
    s/__SCOPE_RE__/$ENV{SCOPE}/g;
    s/__SCOPE__/$ENV{SCOPE}/g;
    s/__NODE_MAJOR__/$ENV{NODE_MAJOR}/g;
    s/__PNPM__/$ENV{PNPM_VERSION}/g;
  ' "${WRITTEN[@]}"
fi

# Record the CLAUDE.md block hash (only when architecture.json was just created)
if grep -q '__CLAUDE_SHA__' architecture.json 2>/dev/null; then
  CLAUDE_SHA="$(node scripts/arch-check.mjs --claude-hash)"
  CLAUDE_SHA="$CLAUDE_SHA" perl -pi -e 's/__CLAUDE_SHA__/$ENV{CLAUDE_SHA}/g' architecture.json
fi

# --- Install + verify ----------------------------------------------------------------------
git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main
if (( INSTALL )); then
  echo "→ Installing dependencies..."
  pnpm install
  if (( ${#WRITTEN[@]} )); then
    pnpm exec biome check --write --files-ignore-unknown=true --no-errors-on-unmatched \
      "${WRITTEN[@]}" >/dev/null || true
  fi
  echo "→ pnpm verify"
  pnpm verify
fi

cat <<EOF

✓ Scaffold ready: $(pwd)  (${#WRITTEN[@]} new files)

Next steps:
  cp .env.example .env && docker compose up -d
  pnpm dev                       # api :3000, web :5173, worker
  .github/CODEOWNERS             # assign owners for architecture files
  git add -A && git commit -m "chore: scaffold"
EOF
