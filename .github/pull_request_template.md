## What and why

<!-- What does this change, and why? Link the issue: "Closes #123". -->

Closes #

## How it was verified

<!-- Commands you ran and their result. CI runs the full suite on Linux, macOS and Windows. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm lint` pass.
- [ ] Tests added or updated for the changed behaviour (guard changes: one in-process test per changed verdict, or a known-limits entry with its reason).
- [ ] Template changes: goldens regenerated with `pnpm vitest run test/golden.test.ts -u` and the diff reviewed; the default golden only changes if the default output is meant to change.
- [ ] README, ADRs (`docs/adr/`) or `GLOSSARY.md` updated if behaviour, design or vocabulary changed.
- [ ] Commit messages follow Conventional Commits.
