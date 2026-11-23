import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  APP_NAMES,
  type AppName,
  PACKAGE_NAMES,
  type PackageName,
  closureOf,
  FULL_SELECTION,
  isAppName,
  isComponentName,
  isPackageName,
  sameClosure,
  type Selection,
  selectionOf,
} from "./components.ts";
import { isPmName, PM_NAMES, type PmName } from "./pm/index.ts";
import type { Options } from "./scaffold.ts";

export const USAGE =
  "Usage: create-monorepo <target-dir> [--apps api,web,worker|none] [--packages domain,contracts,db,core] [--scope @app] [--db-prefix app] [--pm pnpm] [--no-install] [-y|--yes]";

/** A user-facing input error; the CLI maps it to a non-zero exit code. */
export class OptionsError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "OptionsError";
  }
}

/** Returned by a prompter when the user cancels (Ctrl-C) a prompt. */
export const CANCEL: unique symbol = Symbol("cancel");
export type Cancel = typeof CANCEL;

/** Thrown when the user cancels or declines; the CLI exits cleanly (code 0), writing nothing. */
export class CancelledError extends Error {
  readonly exitCode = 0;
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

export interface TextOptions {
  defaultValue?: string | undefined;
  /** Set when re-asking after invalid input. */
  error?: string | undefined;
}

/** Interactive input seam (implemented by the wizard). */
export interface Prompter {
  text(message: string, opts?: TextOptions): Promise<string | Cancel>;
  select(
    message: string,
    choices: readonly string[],
    defaultValue: string,
  ): Promise<string | Cancel>;
  confirm(message: string, defaultValue: boolean): Promise<boolean | Cancel>;
  /** Pick any number of `choices` (including none); `initial` are pre-checked. */
  multiselect(
    message: string,
    choices: readonly string[],
    initial: readonly string[],
  ): Promise<string[] | Cancel>;
}

/** Filesystem inspection seam. */
export interface FsProbe {
  exists(path: string): Promise<boolean>;
  /** True when the path is a directory containing at least one entry. */
  isNonEmptyDir(path: string): Promise<boolean>;
  /** The file's text, or undefined when it does not exist. */
  readText(path: string): Promise<string | undefined>;
}

export type ResolvedOptions = Omit<Options, "nodeMajor" | "selection"> & {
  pm: PmName;
  selection: Selection;
};

const DEFAULT_SCOPE = "@app";
const DB_PREFIX_RE = /^[a-z][a-z0-9_]{0,29}$/;

function isCi(env: Record<string, string | undefined>): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

function detectPm(env: Record<string, string | undefined>): PmName {
  const name = env.npm_config_user_agent?.split("/")[0] ?? "";
  return isPmName(name) ? name : "pnpm";
}

function uncancel<T>(answer: T | Cancel): T {
  if (answer === CANCEL) throw new CancelledError();
  return answer as T;
}

/** Ask until `check` returns no error; cancel throws. */
async function askValid(
  prompter: Prompter,
  message: string,
  defaultValue: string | undefined,
  check: (value: string) => string | undefined,
): Promise<string> {
  let error: string | undefined;
  for (;;) {
    const value = uncancel(await prompter.text(message, { defaultValue, error })).trim();
    error = check(value);
    if (!error) return value;
  }
}

// npm scope rules: lowercase, URL-safe, no leading dot/underscore, 214 chars at most.
const SCOPE_RE = /^@[a-z0-9~-][a-z0-9._~-]{0,212}$/;
const scopeError = (v: string) =>
  SCOPE_RE.test(v)
    ? undefined
    : "--scope must be a valid npm scope: '@' plus lowercase letters, digits, '-', '.', '_' or '~' (e.g. @acme)";
const dbPrefixError = (v: string) =>
  !DB_PREFIX_RE.test(v)
    ? "--db-prefix must match ^[a-z][a-z0-9_]{0,29}$"
    : v.includes("_wt")
      ? "--db-prefix must not contain '_wt': it is the worktree database separator, so another project's databases could be mistaken for this project's worktree databases"
      : undefined;
/** Derives a prefix from the scope and repairs it to be valid (leading letter, no '_wt', 30 chars). */
const deriveDbPrefix = (scope: string) => {
  const base = scope
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_");
  return (/^[a-z]/.test(base) ? base : `db_${base}`).replace(/_wt/g, "_w_t").slice(0, 30);
};
/** Suggests a valid scope for a directory name (lowercase, invalid characters become '-'). */
const suggestScope = (dirName: string) => {
  const name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._]+/, "");
  return SCOPE_RE.test(`@${name}`) ? `@${name}` : DEFAULT_SCOPE;
};

/** Parses `--apps`/`--packages`: a comma list of known names, or `none` for an empty list. */
function parseNames<T extends string>(
  flag: string,
  raw: string,
  known: readonly T[],
  isKnown: (s: string) => s is T,
): T[] {
  const names = raw.split(",").map((n) => n.trim());
  if (names.length === 1 && names[0] === "none") return [];
  const bad = names.find((n) => !isKnown(n));
  if (bad !== undefined) {
    const hint = isComponentName(bad) ? ` ('${bad}' belongs to the other flag)` : "";
    throw new OptionsError(
      `Unknown ${flag} value '${bad}'${hint}. Use a comma list of: ${known.join(", ")} (or 'none')`,
    );
  }
  return [...new Set(names as T[])];
}

/** The Selection recorded by a generated repo's architecture.json. */
function selectionFromArchitecture(text: string): Selection {
  let packages: Record<string, unknown> | undefined;
  try {
    packages = (JSON.parse(text) as { packages?: Record<string, unknown> }).packages;
  } catch {
    packages = undefined;
  }
  if (!packages || typeof packages !== "object") {
    throw new OptionsError(
      "architecture.json exists but its Selection cannot be read (no valid `packages` object). Fix it or scaffold into a new directory.",
    );
  }
  const names = new Set(Object.keys(packages).map((p) => p.split("/")[1] ?? ""));
  return {
    apps: APP_NAMES.filter((n) => names.has(n)),
    packages: PACKAGE_NAMES.filter((n) => names.has(n)),
  };
}

export type ParsedArgs = ReturnType<typeof parse>;

/** Parses argv once; an invalid flag throws an OptionsError carrying the usage text. */
export function parseCli(argv: readonly string[]): ParsedArgs {
  try {
    return parse(argv);
  } catch (error) {
    throw new OptionsError(`${(error as Error).message}\n${USAGE}`);
  }
}

export async function resolveOptions(
  parsed: ParsedArgs,
  env: Record<string, string | undefined>,
  tty: boolean,
  prompter: Prompter,
  fsProbe: FsProbe,
): Promise<ResolvedOptions> {
  const { values, positionals } = parsed;
  const interactive = tty && !isCi(env) && !values.yes;

  let target = positionals[0];
  if (!target) {
    if (!interactive) throw new OptionsError(`Missing <target-dir>\n${USAGE}`);
    target = await askValid(prompter, "Target directory", undefined, (v) =>
      v ? undefined : "Target directory is required",
    );
  }
  const targetPath = resolve(target);

  if (interactive && (await fsProbe.isNonEmptyDir(targetPath))) {
    const proceed = uncancel(
      await prompter.confirm(
        `${targetPath} is not empty. Only missing files will be added; existing files are left untouched. Continue?`,
        true,
      ),
    );
    if (!proceed) throw new CancelledError();
  }

  const selection = await resolveSelection(values, targetPath, interactive, prompter, fsProbe);
  const hasDb = closureOf(selection).has("db");

  let scope = values.scope;
  if (scope === undefined) {
    const fallback = suggestScope(basename(targetPath));
    scope = interactive
      ? await askValid(prompter, "Package scope", fallback, scopeError)
      : DEFAULT_SCOPE;
  }
  const badScope = scopeError(scope);
  if (badScope) throw new OptionsError(badScope);

  let dbPrefix = values["db-prefix"];
  if (!hasDb) {
    // No database, no worktree databases to name: the flag is an error, the prompt is skipped.
    if (dbPrefix !== undefined) {
      throw new OptionsError(
        "--db-prefix needs the db package, but it is not in the Closure of the Selection (no database infrastructure is generated without it). Add db with --packages db, or drop --db-prefix.",
      );
    }
    dbPrefix = deriveDbPrefix(scope);
  } else {
    if (dbPrefix === undefined) {
      const derived = deriveDbPrefix(scope);
      dbPrefix = interactive
        ? await askValid(prompter, "Database prefix", derived, dbPrefixError)
        : derived;
    }
    const badPrefix = dbPrefixError(dbPrefix);
    if (badPrefix) throw new OptionsError(badPrefix);
  }

  let pm = values.pm;
  if (pm === undefined) {
    const detected = detectPm(env);
    pm = interactive
      ? uncancel(await prompter.select("Package manager", PM_NAMES, detected))
      : detected;
  }
  if (!isPmName(pm))
    throw new OptionsError(`Unsupported --pm '${pm}'. Supported: ${PM_NAMES.join(", ")}`);

  let install = !values["no-install"];
  if (install && interactive)
    install = uncancel(await prompter.confirm("Install dependencies?", true));

  return { target: targetPath, scope, dbPrefix, pm, install, selection };
}

/**
 * The Selection to generate. A target that already has architecture.json keeps the Selection it
 * records; flags may only restate it. Otherwise: flags, then prompts, then everything.
 */
async function resolveSelection(
  values: ParsedArgs["values"],
  targetPath: string,
  interactive: boolean,
  prompter: Prompter,
  fsProbe: FsProbe,
): Promise<Selection> {
  const flagApps =
    values.apps === undefined ? undefined : parseNames("--apps", values.apps, APP_NAMES, isAppName);
  const flagPackages =
    values.packages === undefined
      ? undefined
      : parseNames("--packages", values.packages, PACKAGE_NAMES, isPackageName);

  const recorded = await fsProbe.readText(resolve(targetPath, "architecture.json"));
  if (recorded !== undefined) {
    const existing = selectionFromArchitecture(recorded);
    const requested: Selection = {
      apps: flagApps ?? existing.apps,
      packages: flagPackages ?? existing.packages,
    };
    if (!sameClosure(closureOf(requested), closureOf(existing))) {
      throw new OptionsError(
        `--apps/--packages conflict with the existing architecture.json, which has: ${[...closureOf(existing)].join(", ") || "no components"}. Changing the Selection of an existing repo needs an accepted ADR (docs/adr/0002-deferred-packages.md); remove the flags to keep it.`,
      );
    }
    return existing;
  }

  const apps: readonly AppName[] =
    flagApps ??
    (interactive
      ? (uncancel(
          await prompter.multiselect("Apps", APP_NAMES, APP_NAMES),
        ) as AppName[])
      : FULL_SELECTION.apps);
  let packages: readonly PackageName[] = flagPackages ?? [];
  if (flagPackages === undefined && interactive) {
    const inClosure = closureOf({ apps, packages: [] });
    const extra = PACKAGE_NAMES.filter((n) => !inClosure.has(n));
    if (extra.length > 0) {
      packages = uncancel(
        await prompter.multiselect("Extra packages (not already required by the apps)", extra, []),
      ) as PackageName[];
    }
  }
  // The default Selection is everything; flags narrow only what they name.
  const selection: Selection = { apps, packages };
  if (closureOf(selection).size === 0) {
    throw new OptionsError(
      "Nothing selected: pick at least one app or package (--apps, --packages).",
    );
  }
  return selectionOf(closureOf(selection));
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      apps: { type: "string" },
      packages: { type: "string" },
      scope: { type: "string" },
      "db-prefix": { type: "string" },
      pm: { type: "string" },
      "no-install": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}
