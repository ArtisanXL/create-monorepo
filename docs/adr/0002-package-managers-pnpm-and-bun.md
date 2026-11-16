# 2. Support pnpm and bun only; runtime stays Node

Status: accepted (2026-11-16)

## Context

Generated repos rely on a version catalog, the `workspace:*` protocol and strict (non-hoisted)
installs; the architecture guarantees assume all three. Users want to choose a package manager.

## Decision

- Supported package managers: **pnpm** (default) and **bun**. npm is excluded (no catalog, no
  `workspace:` protocol, hoisted installs). Yarn is excluded for now (extra PnP/linker burden).
- Default is detected from `npm_config_user_agent`, falling back to pnpm; overridable with
  `--pm pnpm|bun` or the interactive prompt.
- bun is used only as the package manager and script runner. Apps, tests and guard scripts run
  on Node, avoiding runtime-compatibility risk (pg-boss, Vite, Vitest).
- The chosen package manager is recorded in `architecture.json`; the guard hook blocks install
  commands of every other package manager so no second lockfile appears.
- 0.1.0 ships pnpm only behind a package-manager seam; bun lands in 0.2.0.

## Consequences

- Template and test matrix stays at two package managers and one runtime.
- A Bun-runtime option (`--runtime`) can be added later without changing this seam.
