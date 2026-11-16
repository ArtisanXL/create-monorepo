# 1. Ship the scaffold as a TypeScript npm package

Status: accepted (2026-11-16)

## Context

The scaffold was a single bash script (`scaffold-monorepo.sh`), concatenated from `parts/*.sh`.
About 85% of it was heredoc templates (JS/TS/JSON), including the most critical logic: the
architecture check, the agent guard hook and the worktree script. That code could not be linted,
type-checked or unit-tested, placeholders were filled with perl, and GNU/BSD tool differences
were a portability risk. Node ≥ 24 was already required.

## Decision

Rewrite the generator in TypeScript and publish it as `@artisanxl/create-monorepo`, run via
`npx @artisanxl/create-monorepo` / `npm create @artisanxl/monorepo`. Templates live as real files
under `templates/`. The bash script, `parts/` and `build.sh` are removed.

## Consequences

- Lost: copy-one-file-and-run distribution; using it now needs npm registry access.
- Gained: lintable and testable templates (guard, arch-check, worktree), structured placeholder
  filling, no perl dependency, cross-platform behaviour, an interactive mode.
- The package must ship compiled JS: Node does not strip types for files inside `node_modules`.
