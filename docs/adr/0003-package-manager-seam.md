# 3. Package-manager seam: adapter tokens and adapter-owned files

Status: accepted

## Context

ADR-0002 promises bun in 0.2.0 behind a package-manager seam. Until now the pnpm spelling was
hardcoded in 46 template lines and in the adapter's command members, so adding bun meant editing
about 15 templates and the scaffold core.

## Decision

- Templates name *what* to run through tokens (`__RUN__`, `__FILTER__`, `__INSTALL_FROZEN__`,
  `__RUN_SILENT__`, `__PM_ENSURE__`, `__CI_SETUP__`, `__ADD_DEP__`, `__CATALOG_FILE__`).
  Adapters supply the values as literal text.
- Spellings that are the same for every package manager, the biome flags, and the next-steps
  text live in core.
- One table, `PACKAGE_MANAGERS` in `src/pm/index.ts`, drives `--pm` validation and adapter
  selection. `deps.pm` is the only runtime copy of the choice.
- Each generated file has exactly one writer: either a template or the adapter's `renderFiles`.
  A package manager whose catalog lives in a template (bun) gets an optional `patchTemplate`
  transform in 0.2.0; the template loop stays the only writer.
- The guard's foreign-package-manager list is a block list, not a support list, so it stays.

## Rejected

- Adapter-rendered whole files: CI, `paseo.json` and the hooks would be duplicated per package manager.
- Reading the catalog location from `architecture.json`: it adds a field and changes pnpm output.
- Doing nothing: the bun adapter would have to edit 15 templates and the scaffold core.

## Consequences

- Adding a package manager means one adapter, one table entry and one golden file. Tests reject
  undefined or leftover tokens and stray `pnpm` text in templates.
- arch-check reads bun's JSON catalog with the existing key regex. Root devDependencies may then
  be reported twice.
