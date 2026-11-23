/** The built-in Components, the Selection the user makes, and the Closure that gets generated. */

export const APP_NAMES = ["api", "web", "worker"] as const;
export const PACKAGE_NAMES = ["domain", "contracts", "db", "core"] as const;
export const COMPONENT_NAMES = [...APP_NAMES, ...PACKAGE_NAMES] as const;

export type AppName = (typeof APP_NAMES)[number];
export type PackageName = (typeof PACKAGE_NAMES)[number];
export type ComponentName = (typeof COMPONENT_NAMES)[number];

export const isAppName = (s: string): s is AppName => (APP_NAMES as readonly string[]).includes(s);
export const isPackageName = (s: string): s is PackageName =>
  (PACKAGE_NAMES as readonly string[]).includes(s);
export const isComponentName = (s: string): s is ComponentName =>
  (COMPONENT_NAMES as readonly string[]).includes(s);

/** The Components each Component forces into the Closure (ADR-0001 directions, as generated). */
const REQUIRES: Readonly<Record<ComponentName, readonly ComponentName[]>> = {
  domain: [],
  contracts: [],
  db: ["domain"],
  core: ["domain", "contracts", "db"],
  api: ["core"],
  worker: ["core"],
  // Standalone `web` needs nothing. The connected form only exists when `api` is in the Closure,
  // and `api` already pulls in everything the connected form uses.
  web: [],
};

/** What the user asked for: chosen Apps plus extra Packages. */
export interface Selection {
  apps: readonly AppName[];
  packages: readonly PackageName[];
}

/** Every Component. */
export const FULL_SELECTION: Selection = { apps: APP_NAMES, packages: PACKAGE_NAMES };

/** The Selection plus everything it depends on, transitively; in `COMPONENT_NAMES` order. */
export type Closure = ReadonlySet<ComponentName>;

export function closureOf(selection: Selection): Closure {
  const seen = new Set<ComponentName>();
  const visit = (name: ComponentName) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of REQUIRES[name]) visit(dep);
  };
  for (const name of [...selection.apps, ...selection.packages]) visit(name);
  return new Set(COMPONENT_NAMES.filter((n) => seen.has(n)));
}

export const FULL_CLOSURE: Closure = closureOf(FULL_SELECTION);

/** The Runtime a generated repo targets (ADR-0005). */
export const RUNTIMES = ["node", "cloudflare"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export const DEFAULT_RUNTIME: Runtime = "node";
export const isRuntime = (s: string): s is Runtime => (RUNTIMES as readonly string[]).includes(s);

/**
 * The `compatibility_date` written into every `wrangler.jsonc`. A constant of the generator,
 * bumped per release: not the scaffold date, so goldens stay deterministic and a generated repo
 * never gets a date newer than the workerd its install resolves.
 */
export const COMPATIBILITY_DATE = "2026-11-01";

/** The Hyperdrive binding name in `wrangler.jsonc`, the entry and `loadEnv`. */
export const HYPERDRIVE_BINDING = "HYPERDRIVE";

/** What block resolution, file inclusion and ownership checks read: the Closure and the Runtime. */
export interface ResolutionContext {
  closure: Closure;
  runtime: Runtime;
}

export const contextOf = (
  selection: Selection,
  runtime: Runtime = DEFAULT_RUNTIME,
): ResolutionContext => ({ closure: closureOf(selection), runtime });

export const FULL_CONTEXT: ResolutionContext = { closure: FULL_CLOSURE, runtime: DEFAULT_RUNTIME };

/** Components outside the Closure, which become `deferred`. */
export const absentFrom = (closure: Closure): ComponentName[] =>
  COMPONENT_NAMES.filter((n) => !closure.has(n));

/** The Selection that reproduces exactly `closure` (used to re-read a generated repo). */
export function selectionOf(closure: Closure): Selection {
  return {
    apps: APP_NAMES.filter((n) => closure.has(n)),
    packages: PACKAGE_NAMES.filter((n) => closure.has(n)),
  };
}

export const sameClosure = (a: Closure, b: Closure): boolean =>
  a.size === b.size && [...a].every((n) => b.has(n));

/** Template files that only exist with a Component other than the one whose folder holds them. */
const OWNED_FILES: Readonly<Record<string, ComponentName>> = {
  "apps/web/src/lib/api.ts": "api",
  "compose.yaml": "db",
  ".worktreeinclude": "db",
  "scripts/worktree.mjs": "db",
  "scripts/worktree-lib.mjs": "db",
  "scripts/worktree-lib.test.mjs": "db",
  "scripts/cloudflare-dev.mjs": "api",
  "scripts/cloudflare-dev.test.mjs": "api",
  "docs/adr/0003-job-queue-pg-boss.md": "worker",
  "docs/adr/0004-worktree-isolation.md": "db",
};

/** Components a generated path needs in the Closure; empty for files every repo gets. */
export function componentsNeededBy(dest: string): ComponentName[] {
  const needed: ComponentName[] = [];
  const [top, name] = dest.split("/");
  if ((top === "apps" || top === "packages") && name && isComponentName(name)) needed.push(name);
  const owner = OWNED_FILES[dest];
  if (owner) needed.push(owner);
  return needed;
}

/**
 * Template files that exist under one Runtime only (ADR-0005). With the Component ownership
 * above, no path has two writers.
 */
export const RUNTIME_OWNED_FILES: Readonly<Record<string, Runtime>> = {
  "apps/api/wrangler.jsonc": "cloudflare",
  "apps/api/src/cloudflare.ts": "cloudflare",
  "apps/api/src/server.ts": "node",
  "apps/api/tsdown.config.ts": "node",
  "apps/api/.dev.vars.example": "cloudflare",
  "scripts/cloudflare-dev.mjs": "cloudflare",
  "scripts/cloudflare-dev.test.mjs": "cloudflare",
};

export const isGenerated = (
  dest: string,
  { closure, runtime }: ResolutionContext,
  runtimeOwned: Readonly<Record<string, Runtime>> = RUNTIME_OWNED_FILES,
): boolean =>
  componentsNeededBy(dest).every((c) => closure.has(c)) &&
  (runtimeOwned[dest] ?? runtime) === runtime;

/** Apps that already run on Cloudflare; later tickets add `worker` and `web`. */
const CLOUDFLARE_APPS: readonly AppName[] = ["api"];

/**
 * Why `runtime` cannot generate `closure` yet, or undefined when the combination is supported.
 * Later tickets widen this until the App tickets are all in, and the last one removes it.
 */
export function runtimeSupportError(closure: Closure, runtime: Runtime): string | undefined {
  if (runtime === "node") return undefined;
  const unsupported = APP_NAMES.filter((n) => closure.has(n) && !CLOUDFLARE_APPS.includes(n));
  if (unsupported.length === 0) return undefined;
  return `--runtime ${runtime} is not yet supported with ${unsupported.join(", ")}: those Apps are not available on ${runtime} yet. Use --apps ${CLOUDFLARE_APPS.join(",")} or none, or --runtime node.`;
}
