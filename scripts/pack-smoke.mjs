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
import { closureOf, isGenerated } from "../src/components.ts";
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

  const generate = (name, args) => {
    const target = join(work, name);
    run("npx", ["--no-install", "create-monorepo", target, "-y", ...args], consumer);
    return target;
  };
  const checkFiles = (target, selection) => {
    const closure = closureOf(selection);
    const files = [
      ...expected.filter((f) => isGenerated(f, closure)),
      "pnpm-workspace.yaml",
      "CLAUDE.md",
    ];
    for (const f of files) {
      if (!existsSync(join(target, f))) throw new Error(`${target} lacks ${f}`);
    }
    const leftover = readFileSync(join(target, "package.json"), "utf8").match(
      /__[A-Z_]+__|^@(if|endif)/m,
    );
    if (leftover) throw new Error(`unfilled placeholder ${leftover[0]} in generated package.json`);
  };

  // The default Selection: files only (the repo's own CI runs the full verify on it).
  checkFiles(
    generate("default", ["--no-install"]),
    closureOf({ apps: ["api", "web", "worker"], packages: ["domain", "contracts", "db", "core"] }),
  );

  // The Selections without a database: a real install and `verify` (scaffold runs both).
  for (const [name, args, selection] of [
    ["web", ["--apps", "web"], { apps: ["web"], packages: [] }],
    [
      "library",
      ["--apps", "none", "--packages", "domain,contracts"],
      { apps: [], packages: ["domain", "contracts"] },
    ],
  ]) {
    checkFiles(generate(name, args), selection);
    console.log(`verify OK: ${name}`);
  }
  console.log("pack-smoke OK");
} catch (error) {
  console.error(`pack-smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
