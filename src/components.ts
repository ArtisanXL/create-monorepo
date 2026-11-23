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

export const isGenerated = (dest: string, closure: Closure): boolean =>
  componentsNeededBy(dest).every((c) => closure.has(c));
