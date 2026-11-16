import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPnpmAdapter } from "./pm/pnpm.ts";
import { createRegistryResolver } from "./registry.ts";
import { formatResult } from "./report.ts";
import { scaffold } from "./scaffold.ts";

const USAGE = "Usage: create-monorepo <target-dir> [--scope @app] [--db-prefix app] [--no-install]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scope: { type: "string", default: "@app" },
      "db-prefix": { type: "string" },
      "no-install": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const [target] = positionals;
  if (!target) fail(USAGE);

  const scope = values.scope;
  if (!scope.startsWith("@")) fail("--scope must start with '@'");
  const dbPrefix =
    values["db-prefix"] ??
    scope
      .slice(1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_");
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(dbPrefix))
    fail("--db-prefix must match ^[a-z][a-z0-9_]{0,29}$");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24) fail(`Node >= 24 required (found: ${nodeMajor})`);

  const pm = createPnpmAdapter();
  const result = await scaffold(
    {
      target: resolve(target),
      scope,
      dbPrefix,
      pm: "pnpm",
      install: !values["no-install"],
      nodeMajor,
    },
    {
      resolveVersion: createRegistryResolver(),
      run: (cmd, args, cwd) =>
        new Promise((done, reject) => {
          const child = spawn(cmd, args, {
            cwd,
            stdio: args[0] === "rev-parse" ? "ignore" : "inherit",
          });
          child.on("error", reject);
          child.on("close", (code) => done({ code: code ?? 1 }));
        }),
      pm,
    },
  );
  console.log(formatResult(result, resolve(target), pm.nextSteps()));
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
