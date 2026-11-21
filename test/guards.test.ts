import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
function guard(toolName: string, toolInput: Record<string, unknown>, rawStdin?: string) {
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
    child.stdin.end(
      rawStdin ?? JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: dir }),
    );
  });
}
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
        code: 1,
        stderr: expect.stringContaining("scaffold block was modified"),
      });
    } finally {
      await writeFile(path, original);
    }
  });
});

describe("generated guard hook", () => {
  // The decision rules are covered in-process by guard-rules.test.ts; this only checks the adapter.
  it("exits 0 for an allowed call and 2 with the stderr format for a blocked one", async () => {
    expect((await write("packages/domain/src/money.ts")).code).toBe(0);
    const blocked = await write("architecture.json");
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toBe(
      "⛔ architecture.json is protected; only humans may change it. If a change is needed, write an ADR draft under docs/adr/proposed/ and ask the user.\nRules: CLAUDE.md and architecture.json.\n",
    );
  });

  it("fails closed: malformed stdin blocks with exit 2", async () => {
    const r = await guard("Write", {}, "not json");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("The guard hook failed");
  });

  it("fails closed: a malformed architecture.json blocks with exit 2", async () => {
    const path = join(dir, "architecture.json");
    const original = await readFile(path, "utf8");
    await writeFile(path, "{ broken");
    try {
      const r = await write("packages/domain/src/money.ts");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("The guard hook failed");
    } finally {
      await writeFile(path, original);
    }
  });

  it("fails closed: a missing rules module blocks with exit 2", async () => {
    const path = join(dir, "scripts/guard-rules.mjs");
    const original = await readFile(path, "utf8");
    await rm(path);
    try {
      const r = await write("packages/domain/src/money.ts");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("The guard hook failed");
    } finally {
      await writeFile(path, original);
    }
  });

  it("records the chosen package manager in architecture.json", async () => {
    const arch = JSON.parse(await readFile(join(dir, "architecture.json"), "utf8"));
    expect(arch.package_manager).toBe("pnpm");
  });
});

describe("arch-check on a CRLF CLAUDE.md", () => {
  const claudeMd = () => join(dir, "CLAUDE.md");
  let original: string;
  beforeAll(async () => {
    original = await readFile(claudeMd(), "utf8");
    await writeFile(claudeMd(), original.replace(/\r?\n/g, "\r\n"));
  });
  afterAll(() => writeFile(claudeMd(), original));

  it("arch-check hashes it like the LF version, and the recorded hash passes", async () => {
    const run = (args: string[]) =>
      execFileAsync("node", ["scripts/arch-check.mjs", ...args], { cwd: dir });
    const crlf = (await run(["--claude-hash"])).stdout.trim();
    await writeFile(claudeMd(), (await readFile(claudeMd(), "utf8")).replace(/\r\n/g, "\n"));
    expect((await run(["--claude-hash"])).stdout.trim()).toBe(crlf);
    await writeFile(claudeMd(), (await readFile(claudeMd(), "utf8")).replace(/\n/g, "\r\n"));
    expect((await run([])).stdout).toContain("Architecture check passed");
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
