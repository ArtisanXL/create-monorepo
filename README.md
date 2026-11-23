# @artisanxl/create-monorepo

Generates a guard-railed TypeScript monorepo designed for development with AI agents (Claude Code).

```bash
npx @artisanxl/create-monorepo my-app
# or
npm create @artisanxl/monorepo my-app
pnpm create @artisanxl/monorepo my-app
```

Requires Node ≥ 24 and git. Run it with no arguments in a terminal and a wizard asks for anything
you did not pass on the command line.

## Usage

```text
create-monorepo <target-dir> [--scope @app] [--db-prefix app] [--pm pnpm] [--no-install] [-y|--yes]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `<target-dir>` | required | Directory to scaffold into. Created if missing. |
| `--scope` | `@<dir-name>` in the wizard, `@app` otherwise | npm scope of the workspace packages. |
| `--db-prefix` | derived from the scope | Postgres database name prefix (`^[a-z][a-z0-9_]{0,29}$`, no `_wt`). |
| `--pm` | detected from how you ran it, else `pnpm` | Package manager. `0.1.x` supports `pnpm` only. |
| `--no-install` | install on | Skip install, formatting and `verify`. |
| `-y`, `--yes` | off | Accept defaults for everything not given; never prompt. |

**Wizard.** In an interactive terminal it prompts for the target directory, scope, database
prefix, package manager and whether to install. Invalid input is rejected and asked again. If the
target directory is not empty, it asks for confirmation first: only missing files are added and
existing files are never touched. Ctrl-C at any prompt exits without writing anything.

**Automation.** When stdin/stdout is not a TTY, `CI` is set, or `--yes` is passed, it never
prompts. A missing `<target-dir>` is then an error.

**What a run does.** Resolves dependency versions from the npm registry (latest stable; a
registry failure aborts before any file is written), writes the missing files, appends the rules
block to `CLAUDE.md`, runs `git init` if needed, then (unless `--no-install`) installs, formats
the written files and runs `verify`. Re-running on an existing repo is safe: nothing is
re-resolved or overwritten, and it reports which files were created and which were skipped.

## What you get

- **Stack:** pnpm (catalog, strict) · Turborepo · TypeScript 7 · Biome · Vitest · Hono (RPC + Zod validator) · Drizzle + postgres.js · pg-boss · React + Vite + TanStack Query · tsdown
- **Packages:** `apps/{api,web,worker}`, `packages/{domain,contracts,db,core}`.
- **Architecture contract:** `architecture.json` (allowed packages, dependency matrix, deferred packages/dependencies, protected paths, package manager), enforced by `scripts/arch-check.mjs` (`pnpm arch`).
- **Agent guardrails:** `.claude/hooks/guard.mjs` (PreToolUse) blocks writes to protected files, creating undeclared or deferred packages, installing deferred dependencies, install commands of other package managers, and `--no-verify`. The Stop hook does not let the agent finish until the architecture and lint checks pass. The same checks run in pre-commit and CI.
- **Idempotent:** Existing files are never touched; only missing ones are created. A marked rules block is appended to `CLAUDE.md` once, preserving existing content. The block is protected by the hook and a sha256 check; everything outside it can be edited freely.
- **Paseo + worktrees:** `paseo.json` (setup/teardown, `api`/`web`/`worker` services on Paseo-assigned ports, helper scripts) and `.worktreeinclude`. `pnpm worktree:setup|teardown|info|gc` (`scripts/worktree.mjs`) gives every git worktree its own `.env` and Postgres database `<db-prefix>_wt_<key>` (pg-boss queues included), never touching the main checkout's database.
- **Language policy:** Agents chat in the user's language; everything else (code, comments, docs, ADRs, commits) is English.

Postgres for the generated repo: `docker compose up -d`.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm build && pnpm smoke:pack   # build dist/ and smoke-test the packed tarball
node dist/cli.mjs /tmp/demo -y  # run the local build
```

`src/` is the generator, `templates/` holds the generated files with `__PLACEHOLDER__` tokens.
The generated `.mjs` scripts (guard, arch-check, worktree) are linted and tested here. Design
decisions live in `docs/adr/`.

## Releasing

Bump `version` in `package.json`, merge to `main`, then push a matching tag:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

`.github/workflows/release.yml` checks that the tag matches the package version, runs the checks,
and publishes to npm with provenance via trusted publishing (OIDC; no npm token is stored).

## License

MIT
