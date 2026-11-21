# Project rules

This block is protected by `.claude/hooks/guard.mjs` and `__RUN__ arch`. Anything outside it may be edited freely.

## Language
Chat with the user in the user's language. Everything else — code, comments, docs, ADRs, commit messages, PR text, log and error messages — is written in English.

## Commands
- `__RUN__ verify`: architecture, lint, typecheck and tests. **Work is done only when this passes.**
- `__RUN__ dev`: all apps. Postgres via `docker compose up -d`.
- `__RUN__ arch`: architecture check only.
- `__RUN__ worktree:setup` / `worktree:info`: per-worktree `.env` + database (Paseo runs setup automatically; see `paseo.json`). Never hard-code ports; services get `$PASEO_PORT`.
- `__ADD_DEP__ __SCOPE__/<target>`: add a dependency; the version is written to the catalog.

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
