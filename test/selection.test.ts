import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasDirectiveLines } from "../src/blocks.ts";
import { closureOf, type Selection } from "../src/components.ts";
import { scaffoldFixture } from "./support/fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function generate(selection: Selection) {
  const { dir, cleanup } = await scaffoldFixture({ selection });
  cleanups.push(cleanup);
  const read = (rel: string) => readFile(join(dir, rel), "utf8");
  const json = async (rel: string) => JSON.parse(await read(rel));
  const files = async (rel = ""): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await files(p)));
      else out.push(p);
    }
    return out.sort();
  };
  return { dir, read, json, files };
}

const API: Selection = { apps: ["api"], packages: [] };
const WEB: Selection = { apps: ["web"], packages: [] };
const WORKER: Selection = { apps: ["worker"], packages: [] };
const LIBRARY: Selection = { apps: [], packages: ["domain", "contracts"] };

const DB_FILES = [
  "compose.yaml",
  ".worktreeinclude",
  "scripts/worktree.mjs",
  "scripts/worktree-lib.mjs",
  "scripts/worktree-lib.test.mjs",
  "docs/adr/0004-worktree-isolation.md",
];

describe.each([
  ["api", API],
  ["web", WEB],
  ["worker", WORKER],
  ["library", LIBRARY],
  ["db only", { apps: [], packages: ["db"] } satisfies Selection],
  ["web + domain", { apps: ["web"], packages: ["domain"] } satisfies Selection],
])("generated repo for %s", (_name, selection) => {
  it("has no leftover directives or tokens, valid JSON, and passes its own arch check", async () => {
    const repo = await generate(selection);
    for (const f of await repo.files()) {
      const text = await repo.read(f);
      expect(hasDirectiveLines(text), f).toBe(false);
      expect(text, f).not.toMatch(/__[A-Z_]+__/);
      if (f.endsWith(".json") && !f.includes("tsconfig")) JSON.parse(text);
    }
    // Hook-less, install-less structural check shipped with the generated repo.
    execFileSync("node", ["scripts/arch-check.mjs"], { cwd: repo.dir, stdio: "pipe" });
  });

  it("generates exactly the Closure's components and records the rest as deferred", async () => {
    const repo = await generate(selection);
    const closure = closureOf(selection);
    const arch = await repo.json("architecture.json");
    const present = Object.keys(arch.packages).map((p) => p.split("/")[1]);
    expect(present.sort()).toEqual([...closure].sort());
    const deferred = arch.deferred.map((d: { name: string }) => d.name);
    for (const n of ["api", "web", "worker", "core", "db", "domain", "contracts"]) {
      expect(deferred.includes(n), n).toBe(!closure.has(n as never));
    }
    // References to absent Components are pruned.
    const known = new Set(Object.keys(arch.packages));
    for (const entry of Object.values(arch.packages) as {
      may_depend_on: string[];
      type_only?: string[];
    }[]) {
      for (const ref of [...entry.may_depend_on, ...(entry.type_only ?? [])]) {
        expect(known.has(ref), ref).toBe(true);
      }
    }
  });
});

describe("Decision 5: deferred entries", () => {
  it("carries the trigger and distinctive dependencies of an absent built-in", async () => {
    const repo = await generate(LIBRARY);
    const { deferred } = await repo.json("architecture.json");
    const byName = Object.fromEntries(deferred.map((d: { name: string }) => [d.name, d]));
    expect(byName.api).toMatchObject({
      path: "apps/api",
      trigger: "When the first HTTP endpoint is needed.",
      deps: ["hono", "@hono/node-server", "@hono/zod-validator"],
    });
    expect(byName.web.deps).toEqual([
      "react",
      "react-dom",
      "vite",
      "@vitejs/plugin-react",
      "@tanstack/react-query",
    ]);
    expect(byName.worker.deps).toEqual(["pg-boss"]);
    expect(byName.db.deps).toEqual(["drizzle-orm", "drizzle-kit", "postgres"]);
    expect(byName.core).toMatchObject({ path: "packages/core", deps: [] });
    // The generated repo's own deferred entries stay after the built-ins.
    expect(byName.auth).toBeDefined();
  });

  it("reads 'No API client.' for standalone web", async () => {
    const repo = await generate(WEB);
    const arch = await repo.json("architecture.json");
    expect(arch.packages["apps/web"]).toMatchObject({
      role: "React SPA. No API client.",
      may_depend_on: [],
    });
    expect(arch.packages["apps/web"].type_only).toBeUndefined();
  });
});

describe("Decision 3/4: zero apps and the two forms of web", () => {
  it("generates a packages-only repo", async () => {
    const repo = await generate(LIBRARY);
    expect((await repo.files()).filter((f) => f.startsWith("apps/"))).toEqual([]);
    expect((await repo.files()).some((f) => f.startsWith("packages/domain/"))).toBe(true);
    const paseo = await repo.json("paseo.json");
    expect(Object.keys(paseo.scripts)).toEqual(["test", "verify"]);
  });

  it("connects web to the API only when api is in the Closure", async () => {
    const standalone = await generate(WEB);
    const main = await standalone.read("apps/web/src/main.tsx");
    expect(main).toContain("<h1>Hello</h1>");
    expect(main).toContain("StrictMode");
    expect(main).not.toMatch(/react-query|api/);
    expect(await standalone.files()).not.toContain("apps/web/src/lib/api.ts");
    const pkg = await standalone.json("apps/web/package.json");
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()).toEqual([
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
      "react",
      "react-dom",
      "vite",
    ]);
    expect(await standalone.read("apps/web/vite.config.ts")).not.toMatch(/proxy|API_URL|process/);
    expect(await standalone.read("apps/web/tsconfig.json")).not.toContain('"node"');
    const paseo = await standalone.json("paseo.json");
    expect(paseo.scripts.web.command).not.toContain("API_URL");
    expect(await standalone.read(".env.example")).toBe("NODE_ENV=development\n");

    const connected = await generate({ apps: ["api", "web"], packages: [] });
    expect(await connected.read("apps/web/src/main.tsx")).toContain("QueryClientProvider");
    expect(await connected.files()).toContain("apps/web/src/lib/api.ts");
    expect((await connected.json("paseo.json")).scripts.web.command).toContain("API_URL");
  });
});

describe("Decision 6: no db, no database infrastructure", () => {
  it.each([
    ["web", WEB],
    ["library", LIBRARY],
  ])("omits it for %s", async (_n, selection) => {
    const repo = await generate(selection);
    const files = await repo.files();
    for (const f of DB_FILES) expect(files, f).not.toContain(f);
    const pkg = await repo.json("package.json");
    expect(Object.keys(pkg.scripts).filter((s) => /^(db|worktree):/.test(s))).toEqual([]);
    expect(pkg.devDependencies.postgres).toBeUndefined();
    const paseo = await repo.json("paseo.json");
    expect(paseo.worktree.setup).toBeUndefined();
    expect(paseo.worktree.teardown).toBeUndefined();
    expect(paseo.scripts["db:migrate"]).toBeUndefined();
    expect(await repo.read(".env.example")).not.toContain("DATABASE_URL");
    expect(await repo.read("CLAUDE.md")).not.toMatch(/worktree|docker compose/);
  });

  it("keeps all of it when db is in the Closure", async () => {
    const repo = await generate(API);
    const files = await repo.files();
    for (const f of DB_FILES) expect(files, f).toContain(f);
    expect((await repo.json("paseo.json")).worktree.setup).toBeDefined();
  });
});

describe("Decision 8: ADRs and the CLAUDE.md block follow the Closure", () => {
  it("generates 0003 only with worker and 0004 only with db, leaving the numbering gaps", async () => {
    const adrs = async (s: Selection) =>
      (await (await generate(s)).files())
        .filter((f) => /^docs\/adr\/\d{4}/.test(f))
        .map((f) => f.slice(9, 13));
    expect(await adrs(API)).toEqual(["0001", "0002", "0004"]);
    expect(await adrs(WORKER)).toEqual(["0001", "0002", "0003", "0004"]);
    expect(await adrs(WEB)).toEqual(["0001", "0002"]);
  });

  it("narrows ADR-0001 and the where-code-goes table", async () => {
    const adr = await (await generate(WEB)).read("docs/adr/0001-package-boundaries.md");
    expect(adr).toContain("standalone React SPA");
    expect(adr).not.toMatch(/hc<AppType>|worker|contracts/);
    const claude = await (await generate(API)).read("CLAUDE.md");
    expect(claude).toContain("`apps/api/src/app.ts`");
    expect(claude).not.toMatch(/apps\/worker|apps\/web/);
    const lib = await (await generate(LIBRARY)).read("CLAUDE.md");
    expect(lib).toContain("`packages/domain`");
    expect(lib).not.toMatch(/packages\/db|packages\/core|apps\/(api|web|worker)/);
  });
});
