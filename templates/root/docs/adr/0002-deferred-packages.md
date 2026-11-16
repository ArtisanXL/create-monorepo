# 0002. Packages deferred until needed

- Status: accepted

## Context
Empty packages and `.gitkeep` folders signal "fill me" to agents and produce speculative code.

## Decision
Packages and dependencies listed under `architecture.json > deferred` are **not created/installed**
until their trigger condition is met and an ADR is accepted. Empty placeholder files (`.gitkeep`) are forbidden.

## Process
1. An agent or developer notices the need.
2. They write a draft under `docs/adr/proposed/NNNN-title.md` following `TEMPLATE.md` (the only ADR path agents may write).
3. A human reviews the draft; if accepted, moves it to `docs/adr/` and updates `architecture.json`.
4. Only then is the package/dependency added.
