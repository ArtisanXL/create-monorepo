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
3. A human runs `__RUN__ adr:review` (interactive; `__RUN__ adr:list` shows the drafts). Accepting moves the draft to `docs/adr/` under the next number and prints its `architecture.json change`, which the human applies by hand. Rejecting asks for a reason and moves the draft to `docs/adr/rejected/`. Agents cannot run `adr:review`.
4. Only then is the package/dependency added.
