import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPnpmAdapter } from "../src/pm/pnpm.ts";
import { type Deps, type Options, scaffold } from "../src/scaffold.ts";

const ROOT_FILES = [
  ".editorconfig",
  ".env.example",
  ".gitignore",
  ".nvmrc",
  ".worktreeinclude",
  "biome.json",
  "compose.yaml",
  "docs/adr/0004-worktree-isolation.md",
  "package.json",
  "paseo.json",
  "pnpm-workspace.yaml",
  "scripts/worktree-lib.mjs",
  "scripts/worktree-lib.test.mjs",
  "scripts/worktree.mjs",
  "tsconfig.base.json",
  "turbo.json",
  "vitest.config.ts",
];

let dir: string;
let resolved: string[];
let commands: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scaffold-test-"));
  resolved = [];
  commands = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const options = (over: Partial<Options> = {}): Options => ({
  target: dir,
  scope: "@acme",
  dbPrefix: "acme",
  pm: "pnpm",
  install: false,
  nodeMajor: 24,
  ...over,
});

const deps = (over: Partial<Deps> = {}): Deps => ({
  resolveVersion: async (pkg) => {
    resolved.push(pkg);
    return "1.2.3";
  },
  run: async (cmd, args) => {
    commands.push([cmd, ...args].join(" "));
    return { code: cmd === "git" && args[0] === "rev-parse" ? 128 : 0 };
  },
  pm: createPnpmAdapter(async () => "9.9.9"),
  ...over,
});

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else out.push(p);
  }
  return out.sort();
}

describe("scaffold: fresh run", () => {
  it("makes the worktree script executable", async () => {
    await scaffold(options(), deps());
    const { mode } = await stat(join(dir, "scripts/worktree.mjs"));
    expect(mode & 0o111).not.toBe(0);
  });

  it("writes the root files with placeholders filled", async () => {
    const result = await scaffold(options(), deps());

    expect(result.written.sort()).toEqual(ROOT_FILES);
    expect(result.skipped).toEqual([]);
    expect(await listFiles(dir)).toEqual(ROOT_FILES);

    for (const f of ROOT_FILES) {
      expect(await readFile(join(dir, f), "utf8")).not.toMatch(/__[A-Z_]+__/);
    }
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("@acme/root");
    expect(pkg.engines.node).toBe(">=24");
    expect(pkg.packageManager).toBe("pnpm@9.9.9");
    expect(pkg.scripts["db:migrate"]).toBe("pnpm --filter @acme/db migrate");
    expect(await readFile(join(dir, ".nvmrc"), "utf8")).toBe("24\n");
  });

  it("maps resolved versions to ranges in the catalog", async () => {
    await scaffold(options(), deps());
    const yaml = await readFile(join(dir, "pnpm-workspace.yaml"), "utf8");
    expect(yaml).toContain('  "typescript": "~1.2.3"\n');
    expect(yaml).toContain('  "@biomejs/biome": "^1.2.3"\n');
    expect(yaml).toContain('  "@hono/zod-validator": "^1.2.3"\n');
    expect(yaml).toContain('  "@types/node": "^24"\n');
    expect(yaml).toContain("catalogMode: strict");
    expect(yaml).toContain("allowBuilds:\n  esbuild: true\n");
    expect(resolved).not.toContain("@types/node");
  });

  it("initialises git when the target is not a repository", async () => {
    await scaffold(options(), deps());
    expect(commands).toContain("git init -q -b main");
  });

  it("makes no install or verify calls with install off", async () => {
    await scaffold(options({ install: false }), deps());
    expect(commands.filter((c) => c.startsWith("pnpm"))).toEqual([]);
  });

  it("runs install, format of written files, then verify with install on", async () => {
    const result = await scaffold(options({ install: true }), deps());
    const pnpmCalls = commands.filter((c) => c.startsWith("pnpm"));
    expect(pnpmCalls).toEqual([
      "pnpm install",
      `pnpm exec biome check --write --files-ignore-unknown=true --no-errors-on-unmatched ${result.written.join(" ")}`,
      "pnpm verify",
    ]);
  });
});

describe("scaffold: re-run", () => {
  it("writes nothing, skips every file and does not resolve versions", async () => {
    await scaffold(options(), deps());
    const before = await Promise.all(ROOT_FILES.map((f) => readFile(join(dir, f), "utf8")));
    resolved.length = 0;

    const result = await scaffold(options(), deps());

    expect(result.written).toEqual([]);
    expect(result.skipped.sort()).toEqual(ROOT_FILES);
    expect(resolved).toEqual([]);
    const after = await Promise.all(ROOT_FILES.map((f) => readFile(join(dir, f), "utf8")));
    expect(after).toEqual(before);
  });

  it("never overwrites an existing file", async () => {
    await writeFile(join(dir, "turbo.json"), "mine\n");
    const result = await scaffold(options(), deps());
    expect(result.skipped).toEqual(["turbo.json"]);
    expect(await readFile(join(dir, "turbo.json"), "utf8")).toBe("mine\n");
  });
});

describe("scaffold: registry failure", () => {
  it("aborts with an error and writes zero files", async () => {
    await mkdir(join(dir, "sub"));
    const failing = deps({
      resolveVersion: async (pkg) => {
        if (pkg === "turbo") throw new Error("registry down");
        return "1.0.0";
      },
    });
    await expect(scaffold(options({ target: join(dir, "sub") }), failing)).rejects.toThrow(
      /registry down/,
    );
    expect(await listFiles(join(dir, "sub"))).toEqual([]);
  });
});
