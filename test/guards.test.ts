import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scaffoldFixture, stubDeclaredPackages } from "./support/fixture.ts";

const execFileAsync = promisify(execFile);

let dir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ dir, cleanup } = await scaffoldFixture());
  await stubDeclaredPackages(dir);
});
afterAll(() => cleanup());

/** Runs the generated guard hook as Claude Code would: JSON on stdin, exit 2 blocks. */
function guard(toolName: string, toolInput: Record<string, unknown>) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("node", [".claude/hooks/guard.mjs"], {
      cwd: dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: dir }));
  });
}
const bash = (command: string) => guard("Bash", { command });
const write = (file_path: string) => guard("Write", { file_path, content: "x" });

describe("generated arch-check", () => {
  it("passes on a fresh scaffold", async () => {
    const { stdout } = await execFileAsync("node", ["scripts/arch-check.mjs"], { cwd: dir });
    expect(stdout).toContain("Architecture check passed");
  });

  it("fails when the CLAUDE.md block was modified", async () => {
    const path = join(dir, "CLAUDE.md");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("# Project rules", "# Changed rules"));
    try {
      await expect(
        execFileAsync("node", ["scripts/arch-check.mjs"], { cwd: dir }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("scaffold block was modified"),
      });
    } finally {
      await writeFile(path, original);
    }
  });

  it("treats inline `type` bindings as type-only imports", async () => {
    const file = join(dir, "apps/web/src/inline-type.ts");
    const run = () => execFileAsync("node", ["scripts/arch-check.mjs"], { cwd: dir });
    try {
      await writeFile(
        file,
        'import { type AppType } from "@acme/api";\nexport type A = AppType;\n',
      );
      await expect(run()).resolves.toBeDefined();
      await writeFile(file, 'import { type AppType, app } from "@acme/api";\nexport { app };\n');
      await expect(run()).rejects.toMatchObject({
        stderr: expect.stringContaining("may only be imported with `import type`"),
      });
    } finally {
      await (await import("node:fs/promises")).rm(file, { force: true });
    }
  });

  it("fails on an undeclared package folder", async () => {
    await mkdir(join(dir, "packages/auth"), { recursive: true });
    await writeFile(join(dir, "packages/auth/index.ts"), "export const a = 1;\n");
    try {
      await expect(
        execFileAsync("node", ["scripts/arch-check.mjs"], { cwd: dir }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("packages/auth: not declared"),
      });
    } finally {
      await (await import("node:fs/promises")).rm(join(dir, "packages/auth"), { recursive: true });
    }
  });
});

describe("generated guard hook", () => {
  it("blocks writes to protected paths", async () => {
    for (const p of [
      "architecture.json",
      "docs/adr/0001-x.md",
      "biome.json",
      ".githooks/pre-commit",
    ]) {
      const r = await write(p);
      expect(r.code, p).toBe(2);
      expect(r.stderr).toContain("protected");
    }
  });

  it("allows the ADR proposal folder and ordinary files", async () => {
    expect((await write("docs/adr/proposed/0004-x.md")).code).toBe(0);
    expect((await write("packages/domain/src/money.ts")).code).toBe(0);
  });

  it("blocks undeclared and deferred packages", async () => {
    const undeclared = await write("packages/widgets/index.ts");
    expect(undeclared.code).toBe(2);
    expect(undeclared.stderr).toContain("not a package declared");
    const deferred = await write("packages/auth/index.ts");
    expect(deferred.code).toBe(2);
    expect(deferred.stderr).toContain('deferred "auth"');
  });

  it("blocks installing deferred dependencies", async () => {
    const r = await bash("pnpm add better-auth --filter @acme/core");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('"better-auth" cannot be installed');
    expect((await bash("pnpm add zod --filter @acme/contracts")).code).toBe(0);
  });

  it("blocks deferred dependencies behind flags such as --filter and -w", async () => {
    for (const cmd of [
      "pnpm --filter @acme/core add better-auth",
      "pnpm -w add better-auth",
      "pnpm -F @acme/core install better-auth@1.0.0",
    ]) {
      const r = await bash(cmd);
      expect(r.code, cmd).toBe(2);
      expect(r.stderr, cmd).toContain('"better-auth" cannot be installed');
    }
  });

  it("blocks foreign package managers behind prefixes", async () => {
    for (const cmd of [
      "  npm install foo",
      "sudo npm install",
      "time npm i",
      "env X=1 yarn add zod",
      "corepack npm install",
    ]) {
      const r = await bash(cmd);
      expect(r.code, cmd).toBe(2);
      expect(r.stderr, cmd).toContain("pnpm");
    }
  });

  it("only treats a redirect target as a write", async () => {
    expect((await bash("cat architecture.json > /tmp/arch-copy")).code).toBe(0);
    expect((await bash("cat biome.json | wc -l > /dev/null")).code).toBe(0);
    expect((await bash("echo x > architecture.json")).code).toBe(2);
    expect((await bash("echo x >> docs/adr/0001-x.md")).code).toBe(2);
    expect((await bash("echo x > packages/widgets/a.ts")).code).toBe(2);
  });

  it("records the chosen package manager in architecture.json", async () => {
    const arch = JSON.parse(await readFile(join(dir, "architecture.json"), "utf8"));
    expect(arch.package_manager).toBe("pnpm");
  });

  it("blocks install commands of foreign package managers", async () => {
    for (const cmd of [
      "npm install",
      "npm i left-pad",
      "npm ci",
      "yarn",
      "yarn add zod",
      "bun install",
      "bun add zod",
      "cd apps/api && npm install",
    ]) {
      const r = await bash(cmd);
      expect(r.code, cmd).toBe(2);
      expect(r.stderr, cmd).toContain("pnpm");
    }
  });

  it("allows the chosen package manager and non-install foreign commands", async () => {
    for (const cmd of [
      "pnpm install",
      "pnpm add zod --filter @acme/contracts",
      "pnpm verify",
      "npm --version",
      "git commit -m 'npm install notes'",
    ])
      expect((await bash(cmd)).code, cmd).toBe(0);
  });

  it("blocks --no-verify and git commit -n", async () => {
    expect((await bash("git commit --no-verify -m x")).code).toBe(2);
    expect((await bash("git commit -n -m x")).code).toBe(2);
    expect((await bash("git commit -m x")).code).toBe(0);
  });

  it("blocks edits inside the CLAUDE.md block but not outside it", async () => {
    const inside = await guard("Edit", {
      file_path: join(dir, "CLAUDE.md"),
      old_string: "# Project rules",
      new_string: "# Mine",
    });
    expect(inside.code).toBe(2);
    const outside = await guard("Write", {
      file_path: join(dir, "CLAUDE.md"),
      content: `before\n${await readFile(join(dir, "CLAUDE.md"), "utf8")}`,
    });
    expect(outside.code).toBe(0);
  });
});

describe("generated stop-check hook", () => {
  const entry = () => join(dir, "node_modules/@biomejs/biome/bin/biome");
  const stop = () => {
    const p = execFileAsync("node", [".claude/hooks/stop-check.mjs"], {
      cwd: dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    p.child.stdin?.end("{}");
    return p;
  };

  it("runs biome through its JS entry with the current Node, not the .bin shim", async () => {
    await mkdir(join(dir, "node_modules/@biomejs/biome/bin"), { recursive: true });
    try {
      await writeFile(entry(), "process.exit(process.argv[2] === 'check' ? 0 : 3);\n");
      await expect(stop()).resolves.toBeDefined();
      await writeFile(entry(), "console.error('lint broke');process.exit(1);\n");
      await expect(stop()).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("lint broke"),
      });
    } finally {
      await rm(join(dir, "node_modules"), { recursive: true, force: true });
    }
  });
});

describe("generated file modes", () => {
  it("marks scripts, hooks and the git hook executable", async () => {
    for (const f of [
      "scripts/arch-check.mjs",
      ".claude/hooks/guard.mjs",
      ".claude/hooks/stop-check.mjs",
      ".githooks/pre-commit",
    ]) {
      expect((await stat(join(dir, f))).mode & 0o111, f).not.toBe(0);
    }
  });
});
