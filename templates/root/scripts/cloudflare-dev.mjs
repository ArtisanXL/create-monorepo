/**
 * Dev env for Cloudflare Workers (see docs/adr/0005-runtime-cloudflare-workers.md).
 *   node scripts/cloudflare-dev.mjs -- <command...>   run a command with this worktree's values
 * Sets, for that command only:
 *   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>  this checkout's DATABASE_URL (wrangler
 *                                                            does not read the root .env)
 *   CLOUDFLARE_DEV_REGISTRY_PATH                             unique per checkout, so a service
 *                                                            binding or queue never reaches another
 *                                                            worktree's Worker
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const separator = process.argv.indexOf("--");
  const [command, ...args] = separator === -1 ? [] : process.argv.slice(separator + 1);
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
    env: { ...process.env, ...extra },
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
