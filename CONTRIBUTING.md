# Contributing

Thanks for taking the time to contribute to `@artisanxl/create-monorepo`. This document explains
how to report problems, propose changes and get a pull request merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/ArtisanXL/create-monorepo/issues/new?template=bug_report.yml).
- **Report a guard bypass** (a command the generated `.claude/hooks/guard.mjs` should block but
  allows) with the [guard bypass form](https://github.com/ArtisanXL/create-monorepo/issues/new?template=guard_bypass.yml).
- **Propose a feature** with the [feature request form](https://github.com/ArtisanXL/create-monorepo/issues/new?template=feature_request.yml).
- **Fix something**: issues labelled [`good first issue`](https://github.com/ArtisanXL/create-monorepo/labels/good%20first%20issue) or
  [`help wanted`](https://github.com/ArtisanXL/create-monorepo/labels/help%20wanted) are a good place to start.
- **Improve the docs**: README, ADRs and the glossary are all fair game.

Security vulnerabilities in the CLI itself should **not** be reported in public issues; see
[SECURITY.md](SECURITY.md). For questions, see [SUPPORT.md](SUPPORT.md).

## Scope: what this project is (and is not)

The generator produces one opinionated stack (see the README's "What you get") with guardrails for
AI-agent development. Decisions about that stack are recorded in [`docs/adr/`](docs/adr) and the
vocabulary in [`GLOSSARY.md`](GLOSSARY.md).

Before you start on a feature, open an issue first so we can agree on the approach. Changes that
contradict an accepted ADR (for example, adding a second ORM, or another way to vary files than
`@if` blocks) need a new or amended ADR, not just code. Proposals outside the project's scope may
be declined; that is not a judgement on the idea, only on whether this project should carry it.

## How issues are triaged

New issues get the `needs-triage` label. The maintainer then moves them to one of:

| Label | Meaning |
| --- | --- |
| `needs-info` | Waiting for more information from the reporter. |
| `ready-for-agent` | Fully specified; can be picked up (by a person or an AI agent). |
| `ready-for-human` | Needs human judgement or work that an agent should not do. |
| `wontfix` | Will not be actioned; the issue explains why. |

## Development setup

Requirements: Node ≥ 24, pnpm 12 and git.

```bash
pnpm install
pnpm typecheck && pnpm lint
pnpm vitest run test/<file>.test.ts   # the tests for the area you changed
pnpm build && pnpm smoke:pack         # build dist/ and smoke-test the packed tarball
node dist/cli.mjs /tmp/demo -y        # try the local build
```

Layout:

- `src/`: the generator (CLI, options, wizard, scaffold, package-manager adapters).
- `templates/`: the generated files, with `__PLACEHOLDER__` tokens and line-based `@if <component>`
  … `@endif` blocks (see ADR-0004). `templates/root/package.json.tmpl` keeps the `.tmpl` suffix
  because it is not valid JSON before resolving.
- `templates/root/scripts/` and `templates/root/_claude/hooks/`: the scripts that run inside a
  generated repo (guard, arch-check, worktree). They are linted and tested here.
- `test/`: Vitest suites. `test/golden/*.golden.txt` pin the full output for the default run and
  for several selections.

## Making a change

1. Branch off `main`.
2. Keep the change focused on one issue. Reference it in the PR (`Closes #123`).
3. Add or update tests:
   - Guard changes (`guard-rules.mjs`, `shell-lex.mjs`) need an in-process test for every
     command that changes verdict, or a known-limits entry with its reason.
   - Template changes change the generated output. Regenerate the goldens and review the diff:

     ```bash
     pnpm vitest run test/golden.test.ts -u
     ```

     The default golden (`pnpm.golden.txt`) must only change when the default output is meant to
     change.
4. Run `pnpm typecheck`, `pnpm lint` and the test files you touched. CI runs the full suite on
   Linux, macOS and Windows, plus the pack smoke and an end-to-end scaffold.
5. Update the README, ADRs or glossary when behaviour or vocabulary changes.

### Conventions

- **Language:** code, comments, docs, ADRs and commit messages are in English.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), e.g.
  `feat: …`, `fix(guard): …`, `docs: …`, `test: …`, `chore(deps): …`.
- **Formatting and lint:** Biome (`pnpm format` fixes most issues).
- **Line endings:** LF only (enforced by `.gitattributes`).

## Pull request review

The maintainer reviews every pull request. A PR is merged when:

- CI is green on its latest commit, and
- review comments are resolved.

PRs are merged with a merge commit. Small follow-up fixes can be pushed to the same branch; there
is no need to squash them yourself.

## Releases

Releases are cut by the maintainer: bump `version` in `package.json`, merge, then push a matching
`v*` tag. The release workflow publishes to npm with provenance. See the README's "Releasing".

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
