# create-monorepo

A generator that writes an opinionated TypeScript monorepo (the generated repo) with enforced
package boundaries and agent guardrails.

## Language

**Generated repo**:
The monorepo the scaffold writes into the target directory.
_Avoid_: output, project, target (the target is the directory, not the repo)

**App**:
A deployable unit of the generated repo under `apps/` (api, web, worker).
_Avoid_: service, application

**Package**:
A library unit of the generated repo under `packages/` (domain, contracts, db, core).
_Avoid_: lib, module, workspace

**Component**:
An App or a Package; the thing a Selection is made of.
_Avoid_: feature, unit

**Selection**:
The set of Components the user asks for: chosen Apps plus any extra Packages. The default
Selection is every Component.
_Avoid_: profile, preset

**Closure**:
The Selection plus every Component it depends on, transitively. It is what actually gets
generated; a Selection can add to its Closure but never remove from it.
_Avoid_: resolved selection, expanded set

**Deferred**:
A Component or dependency the generated repo knows about but does not contain until a trigger
is met and an ADR is accepted. Built-in Components left out of the Closure become Deferred.
_Avoid_: disabled, excluded, optional

**Runtime**:
The environment the generated repo's Apps run in: `node` or `cloudflare`. One Runtime per
generated repo; the default is `node`.
_Avoid_: platform, target, edge

**Cloudflare Worker**:
Cloudflare's unit of deployment, always written in full. A bare "worker" means only the `worker`
App, which on the `cloudflare` Runtime is itself deployed as a Cloudflare Worker.
_Avoid_: Worker (alone), edge function
