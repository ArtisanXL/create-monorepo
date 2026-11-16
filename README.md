# ts-monorepo-scaffold

Generates a guard-railed TypeScript monorepo designed for development with AI agents (Claude Code).

```bash
./scaffold-monorepo.sh <target-dir> [--scope @app] [--no-install]
```

- **Stack:** pnpm (catalog, strict) · Turborepo · TypeScript 7 · Biome · Vitest · Hono (RPC + Zod validator) · Drizzle + postgres.js · pg-boss · React + Vite + TanStack Query · tsdown
- **Packages:** `apps/{api,web,worker}`, `packages/{domain,contracts,db,core}`. Versions are resolved from npm (latest stable) at scaffold time.
- **Architecture contract:** `architecture.json` (allowed packages, dependency matrix, deferred packages/dependencies, protected paths), enforced by `scripts/arch-check.mjs` (`pnpm arch`).
- **Agent guardrails:** `.claude/hooks/guard.mjs` (PreToolUse) blocks writes to protected files, creating undeclared or deferred packages, installing deferred dependencies, and `--no-verify`. The Stop hook does not let the agent finish until the architecture and lint checks pass. The same checks run in pre-commit and CI.
- **Idempotent:** Existing files are never touched; only missing ones are created. A marked rules block is appended to `CLAUDE.md` once, preserving existing content. The block is protected by the hook and a sha256 check; everything outside it can be edited freely.
- **Language policy:** Agents chat in the user's language; everything else (code, comments, docs, ADRs, commits) is English.

Requirements: Node ≥ 24, pnpm, git, perl. Postgres via `docker compose up -d`.
