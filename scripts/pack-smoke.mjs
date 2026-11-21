// Pack smoke test: npm pack -> install the tarball in a temp dir -> run the bin with
// `-y --no-install`. Catches missing templates in the package, wrong template paths from the
// build output and a missing shebang. Cross-platform (Linux, macOS, Windows). Needs `pnpm build`.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listTemplateFiles } from "../src/templates.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// npm/npx are .cmd shims on Windows and need a shell there.
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });

const work = mkdtempSync(join(tmpdir(), "pack-smoke-"));

try {
  const packDir = join(work, "pack");
  const consumer = join(work, "consumer");
  mkdirSync(packDir);
  mkdirSync(consumer);

  run("npm", ["pack", "--pack-destination", packDir, "--silent"], root);
  const tarball = readdirSync(packDir)[0];
  if (!tarball) throw new Error("npm pack produced no tarball");
  console.log(`packed ${tarball}`);

  writeFileSync(join(consumer, "package.json"), '{"name":"consumer","private":true}\n');
  run("npm", ["install", join(packDir, tarball), "--no-audit", "--no-fund"], consumer);

  const pkgDir = join(consumer, "node_modules", "@artisanxl", "create-monorepo");
  const cli = join(pkgDir, "dist", "cli.mjs");
  if (!existsSync(cli)) throw new Error("dist/cli.mjs missing from the installed package");
  if (!readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")) {
    throw new Error("dist/cli.mjs has no shebang");
  }

  const target = join(work, "generated");
  run("npx", ["--no-install", "create-monorepo", target, "-y", "--no-install"], consumer);

  // Expected files come from the repo tree; the installed package must ship exactly that tree.
  const expected = (await listTemplateFiles()).map((f) => f.dest);
  const shipped = (await listTemplateFiles(join(pkgDir, "templates"))).map((f) => f.dest);
  const lost = expected.filter((f) => !shipped.includes(f));
  const extra = shipped.filter((f) => !expected.includes(f));
  if (lost.length || extra.length) {
    throw new Error(
      `packed templates differ from the repo tree (missing: ${lost.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    );
  }
  expected.push("pnpm-workspace.yaml", "CLAUDE.md");
  for (const f of expected) {
    if (!existsSync(join(target, f))) throw new Error(`generated repo lacks ${f}`);
  }
  const leftover = readFileSync(join(target, "package.json"), "utf8").match(/__[A-Z_]+__/);
  if (leftover) throw new Error(`unfilled placeholder ${leftover[0]} in generated package.json`);
  console.log("pack-smoke OK");
} catch (error) {
  console.error(`pack-smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
