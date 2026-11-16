import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import {
  type FsProbe,
  OptionsError,
  type Prompter,
  resolveOptions,
  USAGE,
  wantsHelp,
} from "./options.ts";
import { createPnpmAdapter } from "./pm/pnpm.ts";
import { createRegistryResolver } from "./registry.ts";
import { formatResult } from "./report.ts";
import { scaffold } from "./scaffold.ts";

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/** Placeholder prompter until the wizard lands: plain readline questions. */
const prompter: Prompter = {
  async text(message, defaultValue) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        defaultValue ? `${message} (${defaultValue}): ` : `${message}: `,
      );
      return answer.trim() || defaultValue || "";
    } finally {
      rl.close();
    }
  },
};

const fsProbe: FsProbe = {
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
};

async function main() {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return;
  }
  const resolved = await resolveOptions(
    argv,
    process.env,
    Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompter,
    fsProbe,
  );

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24) fail(`Node >= 24 required (found: ${nodeMajor})`);

  const result = await scaffold(
    { ...resolved, nodeMajor },
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
      pm: createPnpmAdapter(),
    },
  );
  console.log(formatResult(result, resolved.target));
}

main().catch((error: unknown) =>
  fail(
    error instanceof Error ? error.message : String(error),
    error instanceof OptionsError ? error.exitCode : 1,
  ),
);
