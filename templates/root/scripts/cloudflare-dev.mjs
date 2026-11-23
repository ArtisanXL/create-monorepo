/**
 * Dev env for Cloudflare Workers (see docs/adr/0005-runtime-cloudflare-workers.md).
 *   node scripts/cloudflare-dev.mjs -- <command...>   run a command with this worktree's values
 * Sets, for that command only:
 *   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>  this checkout's DATABASE_URL (wrangler
 *                                                            does not read the root .env)
 *   CLOUDFLARE_DEV_REGISTRY_PATH                             unique per checkout, so a service
 *                                                            binding or queue never reaches another
 *                                                            worktree's Worker
 *   CLOUDFLARE_INSPECTOR_PORT                                the --port of the command + 10000 (and
 *                                                            --inspector-port for `wrangler dev`), so Workers
 *                                                            started together never probe the same
 *                                                            debugger port (wrangler and the Vite plugin
 *                                                            both try 9229 first and race)
 * Prints no values.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** The Hyperdrive binding name in every wrangler.jsonc. */
const BINDING = "__HYPERDRIVE_BINDING__";

export const hyperdriveLocalEnvName = (binding) =>
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`;

/** Inside the checkout (gitignored), so it is unique per worktree and goes away with it. */
export const devRegistryPath = (toplevel) => join(toplevel, ".wrangler", "dev-registry");

/** The two per-worktree values; throws without a DATABASE_URL rather than let wrangler guess. */
export function devEnv({ binding, databaseUrl, toplevel }) {
  if (!databaseUrl) throw new Error("DATABASE_URL is missing (run the worktree:setup script)");
  return {
    [hyperdriveLocalEnvName(binding)]: databaseUrl,
    CLOUDFLARE_DEV_REGISTRY_PATH: devRegistryPath(toplevel),
  };
}

/** Inspector port for a server on `port`: well above the dev ports, none when it would not fit. */
export function inspectorPortFor(port) {
  const inspector = port + 10000;
  return Number.isInteger(port) && port > 0 && inspector <= 65535 ? inspector : undefined;
}

/** The `--port` of a command line (`--port 8787` or `--port=8787`), if any. */
function portOf(args) {
  for (const [i, arg] of args.entries()) {
    if (arg === "--port") return Number(args[i + 1]);
    if (arg.startsWith("--port=")) return Number(arg.slice("--port=".length));
  }
  return undefined;
}

/**
 * `args` plus a `--inspector-port` derived from its `--port`, for `wrangler dev` only (recognised by
 * its `--ip`; vite rejects unknown options and takes the port from the env instead). Unchanged
 * without a usable port or with its own.
 */
export function withInspectorPort(args) {
  if (!args.some((a) => a === "--ip" || a.startsWith("--ip="))) return args;
  if (args.some((a) => a === "--inspector-port" || a.startsWith("--inspector-port="))) return args;
  const inspector = inspectorPortFor(portOf(args));
  return inspector === undefined ? args : [...args, "--inspector-port", String(inspector)];
}

/** For the Vite plugin, which has no CLI flag for it (apps/web/vite.config.ts reads this). */
function inspectorEnv(args) {
  const inspector = inspectorPortFor(portOf(args));
  return inspector === undefined ? {} : { CLOUDFLARE_INSPECTOR_PORT: String(inspector) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const separator = process.argv.indexOf("--");
  const [command, ...given] = separator === -1 ? [] : process.argv.slice(separator + 1);
  const args = withInspectorPort(given);
  if (!command) {
    console.error("usage: cloudflare-dev -- <command...>");
    process.exit(2);
  }
  const toplevel = process.cwd();
  const envPath = join(toplevel, ".env");
  const fromFile = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  let extra;
  try {
    extra = devEnv({
      binding: BINDING,
      databaseUrl: fromFile.DATABASE_URL ?? process.env.DATABASE_URL,
      toplevel,
    });
  } catch (error) {
    console.error(`cloudflare-dev: ${error.message}`);
    process.exit(1);
  }
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extra, ...inspectorEnv(args) },
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
