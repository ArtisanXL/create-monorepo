import { resolve } from "node:path";
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

/** Interactive input seam (implemented by the wizard). */
export interface Prompter {
  text(message: string, defaultValue?: string): Promise<string>;
}

/** Filesystem inspection seam. */
export interface FsProbe {
  exists(path: string): Promise<boolean>;
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

export async function resolveOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  tty: boolean,
  prompter: Prompter,
  _fsProbe: FsProbe,
): Promise<ResolvedOptions> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new OptionsError(`${(error as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const interactive = tty && !isCi(env) && !values.yes;

  let target = positionals[0];
  if (!target) {
    if (!interactive) throw new OptionsError(`Missing <target-dir>\n${USAGE}`);
    target = (await prompter.text("Target directory")).trim();
    if (!target) throw new OptionsError(`Missing <target-dir>\n${USAGE}`);
  }

  let scope = values.scope;
  if (scope === undefined) {
    scope = interactive
      ? (await prompter.text("Package scope", DEFAULT_SCOPE)).trim()
      : DEFAULT_SCOPE;
  }
  if (!scope.startsWith("@")) throw new OptionsError("--scope must start with '@'");

  const dbPrefix =
    values["db-prefix"] ??
    scope
      .slice(1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_");
  if (!DB_PREFIX_RE.test(dbPrefix))
    throw new OptionsError("--db-prefix must match ^[a-z][a-z0-9_]{0,29}$");

  const pm = values.pm ?? detectPm(env);
  if (!(SUPPORTED_PMS as readonly string[]).includes(pm))
    throw new OptionsError(`Unsupported --pm '${pm}'. Supported: ${SUPPORTED_PMS.join(", ")}`);

  return {
    target: resolve(target),
    scope,
    dbPrefix,
    pm,
    install: !values["no-install"],
  };
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

export function wantsHelp(argv: readonly string[]): boolean {
  try {
    return parse(argv).values.help === true;
  } catch {
    return false;
  }
}
