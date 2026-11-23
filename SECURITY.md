# Security Policy

## Supported versions

Only the latest published version of `@artisanxl/create-monorepo` receives fixes. The project is
pre-1.0, so fixes land in the next patch or minor release rather than being backported.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub:
[Report a vulnerability](https://github.com/ArtisanXL/create-monorepo/security/advisories/new)
(Security tab → "Report a vulnerability"). Do not open a public issue for these.

Include what you can of:

- the affected version and how you ran it (command line, Node version, OS);
- what an attacker can do, and the steps or a proof of concept to reproduce it;
- any suggested fix.

This is a small project with one maintainer. Reports are handled on a best-effort basis; you will
get an acknowledgement in the advisory thread, and the fix and the advisory are published together.
Credit is given in the advisory unless you ask otherwise.

## What counts as a vulnerability

In scope (report privately):

- The CLI writing, deleting or overwriting files outside the target directory, or overwriting
  existing files in it.
- Command or code injection through CLI arguments, prompts, an existing `architecture.json`, or
  the npm registry responses the CLI reads.
- Problems in the published npm package or the release pipeline (supply chain, provenance).
- Secrets or credentials exposed by the generated repository's defaults.

Usually not a vulnerability (please open a normal issue instead):

- **Guard bypasses.** The generated `.claude/hooks/guard.mjs` is a guardrail that keeps AI agents
  away from protected paths. It is not a security boundary against a hostile user, and CI
  (`arch-check`) is the backstop. Report bypasses with the
  [guard bypass form](https://github.com/ArtisanXL/create-monorepo/issues/new?template=guard_bypass.yml).
- Vulnerabilities in dependencies of a generated repository that are already public; those are
  reported by Dependabot or `pnpm audit` in that repository.
