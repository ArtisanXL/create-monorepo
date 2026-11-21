import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Options } from "./scaffold.ts";

/** Package managers with an adapter. */
export const SUPPORTED_PMS = ["pnpm"] as const;

export const USAGE =
  "Usage: create-monorepo <target-dir> [--scope @app] [--db-prefix app] [--pm pnpm] [--no-install] [-y|--yes]";

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
}

/** Filesystem inspection seam. */
export interface FsProbe {
  exists(path: string): Promise<boolean>;
  /** True when the path is a directory containing at least one entry. */
  isNonEmptyDir(path: string): Promise<boolean>;
}

export type ResolvedOptions = Omit<Options, "nodeMajor">;

const DEFAULT_SCOPE = "@app";
const DB_PREFIX_RE = /^[a-z][a-z0-9_]{0,29}$/;

function isCi(env: Record<string, string | undefined>): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

function detectPm(env: Record<string, string | undefined>): string {
  const name = env.npm_config_user_agent?.split("/")[0];
  return (SUPPORTED_PMS as readonly string[]).includes(name ?? "") ? (name as string) : "pnpm";
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
  DB_PREFIX_RE.test(v) ? undefined : "--db-prefix must match ^[a-z][a-z0-9_]{0,29}$";
/** Derives a prefix from the scope and repairs it to fit DB_PREFIX_RE (leading letter, 30 chars). */
const deriveDbPrefix = (scope: string) => {
  const base = scope
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_");
  return (/^[a-z]/.test(base) ? base : `db_${base}`).slice(0, 30);
};
/** Suggests a valid scope for a directory name (lowercase, invalid characters become '-'). */
const suggestScope = (dirName: string) => {
  const name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._]+/, "");
  return SCOPE_RE.test(`@${name}`) ? `@${name}` : DEFAULT_SCOPE;
};

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
  if (dbPrefix === undefined) {
    const derived = deriveDbPrefix(scope);
    dbPrefix = interactive
      ? await askValid(prompter, "Database prefix", derived, dbPrefixError)
      : derived;
  }
  const badPrefix = dbPrefixError(dbPrefix);
  if (badPrefix) throw new OptionsError(badPrefix);

  let pm = values.pm;
  if (pm === undefined) {
    const detected = detectPm(env);
    pm = interactive
      ? uncancel(await prompter.select("Package manager", SUPPORTED_PMS, detected))
      : detected;
  }
  if (!(SUPPORTED_PMS as readonly string[]).includes(pm))
    throw new OptionsError(`Unsupported --pm '${pm}'. Supported: ${SUPPORTED_PMS.join(", ")}`);

  let install = !values["no-install"];
  if (install && interactive)
    install = uncancel(await prompter.confirm("Install dependencies?", true));

  return { target: targetPath, scope, dbPrefix, pm, install };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      scope: { type: "string" },
      "db-prefix": { type: "string" },
      pm: { type: "string" },
      "no-install": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}
