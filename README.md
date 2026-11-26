# @artisanxl/create-monorepo

[![npm](https://img.shields.io/npm/v/@artisanxl/create-monorepo)](https://www.npmjs.com/package/@artisanxl/create-monorepo)
[![CI](https://github.com/ArtisanXL/create-monorepo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ArtisanXL/create-monorepo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Generates a guard-railed TypeScript monorepo designed for development with AI agents (Claude Code).

AI coding agents are fast, but they also delete the wrong folder, add an unplanned dependency or
quietly loosen an architectural rule. The generated repository writes its architecture down as a
machine-checked contract (`architecture.json`) and enforces it in three places: a Claude Code hook
that blocks harmful commands before they run, a Stop hook that keeps the agent working until the
checks pass, and the same checks in pre-commit and CI.

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
create-monorepo <target-dir> [--apps api,web,worker|none] [--packages domain,contracts,db,core] [--scope @app] [--db-prefix app] [--pm pnpm] [--runtime node|cloudflare] [--no-install] [-y|--yes]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `<target-dir>` | required | Directory to scaffold into. Created if missing. |
| `--apps` | all (`api,web,worker`) | Apps to generate; `none` for a packages-only repo. Their dependencies are added automatically (the Closure). |
| `--packages` | none extra | Extra packages to add to the Closure (`domain`, `contracts`, `db`, `core`); packages can be added, never removed from it. |
| `--scope` | `@<dir-name>` in the wizard, `@app` otherwise | npm scope of the workspace packages. |
| `--db-prefix` | derived from the scope | Postgres database name prefix (`^[a-z][a-z0-9_]{0,29}$`, no `_wt`). An error without `db` in the Closure. |
| `--runtime` | asked in the wizard after the package manager, else `node` | Runtime of the generated repo. `cloudflare` generates Cloudflare Workers Apps (any Selection) and is recorded in `architecture.json`; see ADR-0005. |
| `--pm` | detected from how you ran it, else `pnpm` | Package manager. `0.1.x` supports `pnpm` only. |
| `--no-install` | install on | Skip install, formatting and `verify`. |
| `-y`, `--yes` | off | Accept defaults for everything not given; never prompt. |

**Wizard.** In an interactive terminal it prompts for the target directory, scope, database
prefix, package manager and whether to install. Invalid input is rejected and asked again. If the
target directory is not empty, it asks for confirmation first: only missing files are added and
existing files are never touched. Ctrl-C at any prompt exits without writing anything.

**Selectable components.** The wizard asks which apps to generate (all checked), then which extra
packages outside their Closure to add. `web` is connected to the API (`hc<AppType>`, React Query)
only when `api` is in the Closure; otherwise it is a standalone React SPA. Without `db`, no
Postgres or worktree infrastructure is generated. Built-in components left out are recorded under
`architecture.json > deferred`. Re-running on a repo that has `architecture.json` keeps its
Selection; a conflicting `--apps`/`--packages` is an error. See `docs/adr/0004-selectable-components.md`.

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
- **ADR drafts:** agents write drafts under `docs/adr/proposed/`. `pnpm adr:list` shows them; `pnpm adr:review` (interactive, humans only; the guard blocks agents) accepts a draft into `docs/adr/` under the next number, or rejects it into `docs/adr/rejected/` with a reason. Accepting also applies the draft's `architecture.json change` (a JSON Patch, `{{adr}}` = the new ADR's path) after showing the diff and asking `y/N`; if it does not apply, nothing changes (`scripts/adr.mjs`).
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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. `src/` is the generator, `templates/` holds the generated files with `__PLACEHOLDER__` tokens.
The generated `.mjs` scripts (guard, arch-check, worktree) are linted and tested here. Design
decisions live in `docs/adr/`.

## Releasing

Bump `version` in `package.json`, merge to `main`, then push a matching tag:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

`.github/workflows/release.yml` checks that the tag matches the package version, runs the checks,
and publishes to npm with provenance via trusted publishing (OIDC; no npm token is stored).

## Contributing

Bug reports, guard bypasses, ideas and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); it covers the scope of the project, the development setup and
how changes are reviewed. Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

- Questions and help: [SUPPORT.md](SUPPORT.md)
- Security vulnerabilities: report privately, see [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
