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

