import { spawn } from "node:child_process";
import { createPnpmAdapter } from "./pm/pnpm.ts";
import { createRegistryResolver } from "./registry.ts";
import { run } from "./run.ts";
import { clackPrompter, nodeFsProbe } from "./wizard.ts";

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  nodeVersion: process.versions.node,
  prompter: clackPrompter,
  fsProbe: nodeFsProbe,
  stdout: process.stdout,
  stderr: process.stderr,
  makeDeps: () => ({
    resolveVersion: createRegistryResolver(),
    run: (cmd, args, cwd) =>
      new Promise((done, reject) => {
        const child = spawn(cmd, args, {
          cwd,
          shell: process.platform === "win32",
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("close", (code) => done({ code: code ?? 1 }));
      }),
    pm: createPnpmAdapter(),
  }),
});
