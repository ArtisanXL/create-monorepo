import { describe, expect, it } from "vitest";
import { claudeBlockHash } from "../src/claude-md.ts";
import { createPnpmAdapter } from "../src/pm/pnpm.ts";
import { type Deps, gather, type Options, plan, type TargetView } from "../src/scaffold.ts";

const options = (over: Partial<Options> = {}): Options => ({
  target: "/nowhere",
  scope: "@acme",
  dbPrefix: "acme",
  install: false,
  nodeMajor: 24,
  ...over,
});

const deps = (over: Partial<Deps> = {}): Deps => ({
  resolveVersion: async () => "1.2.3",
  run: async () => {
    throw new Error("planning must not run commands");
  },
  pm: createPnpmAdapter(async () => "9.9.9"),
  ...over,
});

const memory = (files: Record<string, string> = {}): TargetView => ({
  exists: (rel) => rel in files,
  read: (rel) => files[rel] as string,
});

const planFor = async (opts = options(), d = deps(), files: Record<string, string> = {}) =>
  plan(await gather(opts, d, memory(files)));

const content = (p: Awaited<ReturnType<typeof planFor>>, path: string) =>
  p.files.find((f) => f.path === path)?.content as string;

describe("plan: fresh target", () => {
  it("fills placeholders and never calls deps.run", async () => {
    const p = await planFor();
    expect(p.skipped).toEqual([]);
    expect(p.written).toEqual(p.files.map((f) => f.path));
    for (const f of p.files) expect(f.content).not.toMatch(/__[A-Z_]+__/);
    const pkg = JSON.parse(content(p, "package.json"));
    expect(pkg.name).toBe("@acme/root");
    expect(pkg.packageManager).toBe("pnpm@9.9.9");
    expect(p.gitInit).toBe(true);
    expect(p.commands).toEqual([]);
  });

  it("maps versions to ranges in the catalog", async () => {
    const yaml = content(await planFor(), "pnpm-workspace.yaml");
    expect(yaml).toContain('  "typescript": "~1.2.3"\n');
    expect(yaml).toContain('  "turbo": "^1.2.3"\n');
    expect(yaml).toContain('  "@types/node": "^24"\n');
  });

  it("marks scripts executable", async () => {
    const p = await planFor();
    expect(p.files.find((f) => f.path === "scripts/worktree.mjs")?.executable).toBe(true);
    expect(p.files.find((f) => f.path === "turbo.json")?.executable).toBe(false);
  });

  it("records the hash of the CLAUDE.md block in architecture.json", async () => {
    const p = await planFor();
    const sha = claudeBlockHash(content(p, "CLAUDE.md"));
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    const withSha = p.files.filter((f) => f.content.includes(sha as string));
    expect(withSha.length).toBeGreaterThan(0);
  });

  it("keeps block.md free of the hash placeholder", async () => {
    const g = await gather(options(), deps(), memory());
    expect(g.blockText).not.toContain("__CLAUDE_SHA__");
  });

  it("adds install, format of written files and verify only with install on", async () => {
    const p = await planFor(options({ install: true }));
    expect(p.commands.map((c) => c.command.join(" "))).toEqual([
      "pnpm install",
      `pnpm exec biome check --write --files-ignore-unknown=true --no-errors-on-unmatched ${p.written.join(" ")}`,
      "pnpm verify",
    ]);
    expect(p.commands.map((c) => c.tolerant)).toEqual([false, true, false]);
  });

  it("fills a scope with regex and replacement characters literally and escaped", async () => {
    const p = await planFor(options({ scope: "@a.b$&" }));
    expect(content(p, "apps/api/tsdown.config.ts")).toContain("noExternal: [/^@a\\.b\\$&\\//]");
    expect(JSON.parse(content(p, "apps/api/package.json")).name).toBe("@a.b$&/api");
  });
});

describe("plan: existing target", () => {
  it("skips existing files without resolving versions when the workspace file exists", async () => {
    const resolved: string[] = [];
    const d = deps({
      resolveVersion: async (pkg) => {
        resolved.push(pkg);
        return "1.0.0";
      },
    });
    const p = await planFor(options(), d, { "turbo.json": "mine", "pnpm-workspace.yaml": "x" });
    expect(p.skipped).toEqual(["pnpm-workspace.yaml", "turbo.json"]);
    expect(p.written).not.toContain("turbo.json");
    expect(resolved).toEqual([]);
  });

  it("plans nothing, no git init and no format step on a complete target", async () => {
    const first = await planFor();
    const files = Object.fromEntries(first.files.map((f) => [f.path, f.content]));
    files[".git"] = "";
    const p = await planFor(options({ install: true }), deps(), files);
    expect(p.files).toEqual([]);
    expect(p.written).toEqual([]);
    expect(p.skipped).toEqual([...first.written].sort());
    expect(p.gitInit).toBe(false);
    expect(p.commands.map((c) => c.command.join(" "))).toEqual(["pnpm install", "pnpm verify"]);
  });

  it("appends the block to an existing CLAUDE.md, preserving its content", async () => {
    const p = await planFor(options(), deps(), { "CLAUDE.md": "# Mine\n" });
    expect(p.written).toContain("CLAUDE.md");
    expect(content(p, "CLAUDE.md").startsWith("# Mine\n")).toBe(true);
    expect(claudeBlockHash(content(p, "CLAUDE.md"))).not.toBeNull();
  });

  it("skips CLAUDE.md that already has the block and hashes the existing block", async () => {
    const existing =
      "# Mine\n\n<!-- scaffold:begin — managed by @artisanxl/create-monorepo -->\ncustom rules\n<!-- scaffold:end -->\n";
    const p = await planFor(options(), deps(), { "CLAUDE.md": existing });
    expect(p.skipped).toEqual(["CLAUDE.md"]);
    expect(p.written).not.toContain("CLAUDE.md");
    const sha = claudeBlockHash(existing) as string;
    expect(content(p, "architecture.json")).toContain(sha);
  });
});

describe("gather: registry failure", () => {
  it("rejects before there is anything to apply", async () => {
    const failing = deps({
      resolveVersion: async (pkg) => {
        if (pkg === "turbo") throw new Error("registry down");
        return "1.0.0";
      },
    });
    await expect(gather(options(), failing, memory())).rejects.toThrow(/registry down/);
  });
});
