# 7. Accepting an ADR draft applies its architecture patch

Status: proposed (2026-11-26)

Refines the review flow of the generated ADR-0002 ("Packages deferred until needed").

## Context

In a generated repo, `adr:review` accepts a draft by moving it to `docs/adr/` and printing the
draft's `architecture.json change` section, which a human then applies by hand. The section is
free-form text, so the accepted ADR and `architecture.json` can drift apart, and a typo in the
manual edit goes unnoticed until `arch-check` fails. Agents cannot write `architecture.json` and
cannot run `adr:review`, so applying the change inside `adr:review` keeps the human-only rule.

## Decision

- The `## architecture.json change` section of a draft holds an **Architecture patch**: a JSON
  Patch (RFC 6902) array in a fenced `json` block. `add`, `remove`, `replace` and `test` are
  supported; `test` lets a draft guard against a stale `architecture.json`.
- Accepting a draft in `adr:review` applies the patch:
  1. Replace the `{{adr}}` placeholder with the path of the accepted ADR (`docs/adr/NNNN-slug.md`).
     Drafts cannot know their number, and `architecture.json` may not reference `proposed/`.
  2. Apply the patch in memory, then check that the result still has the shape the contract readers
     expect (an object; `packages` an object; `deferred` an array; no `adr` pointing into `proposed/`).
  3. Show the before/after of the patched object and ask `y/n`.
  4. Only on `y`, write `architecture.json`, then move the ADR, then delete the draft.
  Any failure (a `test` that does not hold, an invalid result, `n`) changes nothing and leaves the
  draft in `proposed/`.
- A missing or empty section means no change: the ADR is still accepted. A section that is not a
  valid JSON Patch array is an error that blocks acceptance; there is no fallback for the old
  free-form text.
- `architecture.json` is re-serialized with two-space indentation; the script does not try to
  preserve line wrapping, and a human runs `format` afterwards if needed.
- Scope is `architecture.json` only. Creating a Package's files or installing its dependencies
  stays normal development after acceptance.

## Rejected

- **Keep applying by hand:** the status quo; drift and typos remain.
- **Merge Patch (RFC 7396):** replaces arrays wholesale, and `external_allow` and `deferred` are
  arrays.
- **A bespoke operation list:** a new format to document for no gain over JSON Patch.
- **Format-preserving rewrite of `architecture.json`:** too much machinery for a cosmetic gain.
- **Generating the Package's files on accept:** a much larger feature, tracked separately.

## Consequences

- `templates/root/scripts/adr-lib.mjs` and `adr.mjs` gain patch parsing, placeholder replacement,
  validation and the atomic write order; `adr-lib.test.mjs` covers them.
- `TEMPLATE.md`, `proposed/README.md` and the generated ADR-0002 describe the patch format.
- Golden files that include these templates change.
- Existing drafts with free-form change text must be rewritten before they can be accepted.
