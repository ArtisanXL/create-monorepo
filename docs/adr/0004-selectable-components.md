# 4. Selectable components: Closure-based selection and conditional template blocks

Status: proposed

## Context

Every generated repo used to contain all apps (api, web, worker) and all packages (domain,
contracts, db, core). Users want to leave some out. The template code couples them tightly:
every app pulls in every package through `core`, and `web` talks to `api` through `hc<AppType>`.
Several shared files (root `package.json`, `paseo.json`, `architecture.json`, the CLAUDE.md block,
`.env.example`) mention specific components.

## Decision

- The user makes a **Selection**: apps, plus extra packages. What gets generated is the
  **Closure**, meaning the Selection plus its transitive dependencies. A Selection can add to its
  Closure but never remove from it. Zero apps (a packages-only repo) is allowed. The default
  Selection is everything, and its output is byte-identical to the output before this change.
- Dependency directions from the generated repo's ADR-0001 stay as they are. Template code is not
  split into per-selection variants, with one exception: `web` has an api-connected form and a
  standalone form. The Closure decides which one is used (connected if and only if `api` is in
  it). Standalone `web` is a bare React SPA: no API client, no React Query, no proxy, and no
  package dependencies, so its Closure is just itself.
- `architecture.json` names only Components in the Closure and its own `deferred` entries.
  `may_depend_on`/`type_only` references to absent Components are pruned.
- Built-in components left out of the Closure are written to `architecture.json > deferred`
  with a trigger and their distinctive dependencies, so bringing one back follows the generated
  repo's ADR-0002 process.
- Without `db`, the Postgres and worktree-isolation infrastructure is not generated, and
  `--db-prefix` is rejected.
- Shared files vary through **line-based conditional blocks** in the templates
  (`@if <component>` … `@endif`). They are resolved while filling, before token substitution, and
  they work the same in every file type, JSON included. A template is still the only writer of its
  file (ADR-0003).
- The generated repo's ADRs follow the Closure. ADRs owned by an absent Component (job queue →
  `worker`, worktree isolation → `db`) are not generated, and the numbering gaps stay because ADR
  numbers are stable identifiers. The package-boundaries ADR is narrowed with conditional blocks.
- On a target that already has `architecture.json`, the Selection is read from it. A conflicting
  `--apps`/`--packages` is an error.

## Rejected

- Selecting apps and packages independently: with the current coupling, the only result that
  differs from the Closure is "zero apps".
- Post-processing JSON structurally: that is a second mechanism next to text conditionals.
- Rendering the shared files in code: it moves template content out of `templates/` and breaks
  ADR-0003's single-writer model.

## Consequences

- Templates gain a small directive language. lint-templates and the token tests must check it
  (balanced blocks, known component names, no leftovers).
- The golden matrix grows to four Selections: default (unchanged), `api` only, standalone `web`,
  and a packages-only library (`domain` + `contracts`). The last two also run a real `verify` in
  the pack smoke test.
