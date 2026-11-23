import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasDirectiveLines } from "../src/blocks.ts";
import {
  COMPATIBILITY_DATE,
  closureOf,
  HYPERDRIVE_BINDING,
  RUNTIMES,
  type Runtime,
  runtimeSupportError,
  type Selection,
} from "../src/components.ts";
import { scaffoldFixture } from "./support/fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function generate(selection: Selection, runtime: Runtime = "node") {
  const { dir, cleanup } = await scaffoldFixture({ selection, runtime });
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
const FULL: Selection = { apps: ["api", "web", "worker"], packages: [] };
const LIBRARY: Selection = { apps: [], packages: ["domain", "contracts"] };

const DB_FILES = [
  "compose.yaml",
  ".worktreeinclude",
  "scripts/worktree.mjs",
  "scripts/worktree-lib.mjs",
  "scripts/worktree-lib.test.mjs",
  "docs/adr/0004-worktree-isolation.md",
];

const SELECTIONS: [string, Selection][] = [
  ["api", API],
  ["web", WEB],
  ["worker", WORKER],
  ["library", LIBRARY],
  ["db only", { apps: [], packages: ["db"] } satisfies Selection],
  ["web + domain", { apps: ["web"], packages: ["domain"] } satisfies Selection],
];

// The invariant sweep: every Selection x Runtime, restricted to the allowed combinations.
const SWEEP = SELECTIONS.flatMap(([name, selection]) =>
  RUNTIMES.filter((r) => runtimeSupportError(closureOf(selection), r) === undefined).map(
    (runtime) => [`${name} on ${runtime}`, selection, runtime] as const,
  ),
);

describe.each(SWEEP)("generated repo for %s", (_name, selection, runtime) => {
  it("has no leftover directives or tokens, valid JSON, and passes its own arch check", async () => {
    const repo = await generate(selection, runtime);
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
    const repo = await generate(selection, runtime);
    const closure = closureOf(selection);
    const arch = await repo.json("architecture.json");
    const present = Object.keys(arch.packages).map((p) => p.split("/")[1]);
    expect(present.sort()).toEqual([...closure].sort());
    const deferred = arch.deferred.map((d: { name: string }) => d.name);
    for (const n of ["api", "web", "worker", "core", "db", "domain", "contracts"]) {
      expect(deferred.includes(n), n).toBe(!closure.has(n as never));
    }
    // Only `cloudflare` is recorded; a missing field means node.
    expect(arch.runtime).toBe(runtime === "cloudflare" ? "cloudflare" : undefined);
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

describe("review fixes: text that follows the Closure", () => {
  it("ADR-0004 (worktree) keeps the /api proxy sentence for api + web and handles zero apps", async () => {
    const adr = async (s: Selection) =>
      (await generate(s)).read("docs/adr/0004-worktree-isolation.md");
    const both = await adr({ apps: ["api", "web"], packages: [] });
    expect(both).toContain("proxies `/api` to `API_URL`");
    expect(both).toContain("defines the apps as services");
    expect(await adr({ apps: ["api"], packages: [] })).not.toContain("proxies");
    const dbOnly = await adr({ apps: [], packages: ["db"] });
    expect(dbOnly).not.toMatch(/services|proxies|pg-boss/);
    expect(dbOnly).toContain(".worktreeinclude");
  });

  it("architecture.json drops redis-queue without worker and .worktreeinclude without db", async () => {
    const api = await (await generate(API)).json("architecture.json");
    expect(api.deferred.map((d: { name: string }) => d.name)).not.toContain("redis-queue");
    expect(api.protected_paths).toContain(".worktreeinclude");
    const lib = await (await generate(LIBRARY)).json("architecture.json");
    expect(lib.protected_paths).not.toContain(".worktreeinclude");
    const worker = await (await generate(WORKER)).json("architecture.json");
    expect(worker.deferred.map((d: { name: string }) => d.name)).toContain("redis-queue");
  });

  it("the CLAUDE.md block follows the apps in the Closure", async () => {
    const block = async (s: Selection) => (await generate(s)).read("CLAUDE.md");
    const lib = await block(LIBRARY);
    expect(lib).not.toMatch(/`pnpm dev`|PASEO_PORT|apps\./);
    expect(await block(WEB)).toContain("`pnpm dev`: the generated apps.");
    expect(await block(WEB)).toContain("Never hard-code ports");
    const dbOnly = await block({ apps: [], packages: ["db"] });
    expect(dbOnly).toContain("Postgres: `docker compose up -d`.");
    expect(dbOnly).toContain("worktree:setup");
    expect(dbOnly).not.toContain("PASEO_PORT");
    expect(await block(FULL)).toContain("`pnpm dev`: all apps. Postgres via");
  });
});

/** architecture.json minus what legitimately follows the Runtime: the field and `deferred` deps. */
const withoutRuntimeParts = (text: string) => {
  const arch = JSON.parse(text);
  arch.runtime = undefined;
  for (const d of arch.deferred) d.deps = undefined;
  return arch;
};

describe("Runtime axis (ADR-0005)", () => {
  it("packages-only output differs between node and cloudflare only by the runtime line", async () => {
    const node = await generate(LIBRARY, "node");
    const cf = await generate(LIBRARY, "cloudflare");
    expect(await cf.files()).toEqual(await node.files());
    for (const f of await node.files()) {
      const a = await node.read(f);
      const b = await cf.read(f);
      if (f === "architecture.json") {
        // Only the runtime line and the Runtime-specific `deferred` deps differ.
        expect(b).toContain('  "runtime": "cloudflare",\n');
        expect(withoutRuntimeParts(b)).toEqual(withoutRuntimeParts(a));
      } else {
        expect(b, f).toBe(a);
      }
    }
  });

  it("packages-only output stays equal across Runtimes when db is in the Closure", async () => {
    const dbOnly: Selection = { apps: [], packages: ["db"] };
    const node = await generate(dbOnly, "node");
    const cf = await generate(dbOnly, "cloudflare");
    expect(await cf.files()).toEqual(await node.files());
    for (const f of await node.files()) {
      const [a, b] = [await node.read(f), await cf.read(f)];
      if (f === "architecture.json") expect(withoutRuntimeParts(b)).toEqual(withoutRuntimeParts(a));
      else expect(b, f).toBe(a);
    }
  });

  it("does not record a Runtime for node", async () => {
    const repo = await generate(LIBRARY, "node");
    expect(await repo.read("architecture.json")).not.toContain("runtime");
  });
});

describe("api as a Cloudflare Worker (ADR-0005)", () => {
  const node = () => generate(API, "node");
  const cf = () => generate(API, "cloudflare");

  it("generates the Worker files and leaves out the Node-only ones", async () => {
    const files = await (await cf()).files();
    expect(files).toContain("apps/api/wrangler.jsonc");
    expect(files).toContain("apps/api/src/cloudflare.ts");
    expect(files).not.toContain("apps/api/src/server.ts");
    expect(files).not.toContain("apps/api/tsdown.config.ts");
    const nodeFiles = await (await node()).files();
    expect(nodeFiles).toContain("apps/api/src/server.ts");
    expect(nodeFiles).toContain("apps/api/tsdown.config.ts");
    expect(nodeFiles).not.toContain("apps/api/wrangler.jsonc");
    expect(nodeFiles).not.toContain("apps/api/src/cloudflare.ts");
  });

  it("configures nodejs_compat, the generator's compatibility date and a Hyperdrive placeholder", async () => {
    const wrangler = await (await cf()).read("apps/api/wrangler.jsonc");
    expect(wrangler).toContain('"main": "src/cloudflare.ts"');
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain(`"compatibility_date": "${COMPATIBILITY_DATE}"`);
    expect(COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(wrangler).toContain(`"binding": "${HYPERDRIVE_BINDING}"`);
    expect(wrangler).toMatch(/"id": "[^"]*REPLACE[^"]*"/);
  });

  it("reads the connection string from the Hyperdrive binding, per request", async () => {
    const repo = await cf();
    const entry = await repo.read("apps/api/src/cloudflare.ts");
    expect(entry).toContain("createApp");
    expect(entry).toContain(`${HYPERDRIVE_BINDING}.connectionString`);
    expect(entry).toContain("createDb(");
    expect(await repo.read("apps/api/src/env.ts")).toContain(HYPERDRIVE_BINDING);
    expect(await repo.read("apps/api/src/env.ts")).not.toContain("process.env");
    // `db` stays Runtime-neutral: same bytes under both Runtimes, no Workers types.
    const db = await repo.read("packages/db/src/index.ts");
    expect(db).toBe(await (await node()).read("packages/db/src/index.ts"));
    expect(db).not.toMatch(/cloudflare|workers/i);
  });

  it("has Worker scripts, wrangler, and no Node-only dependencies", async () => {
    const pkg = await (await cf()).json("apps/api/package.json");
    expect(pkg.scripts.typecheck).toBe("wrangler types && tsc -p .");
    expect(pkg.scripts.build).toBe("wrangler deploy --dry-run --outdir dist");
    expect(pkg.scripts.deploy).toBe("wrangler deploy");
    expect(pkg.scripts["deploy:dry-run"]).toBe("wrangler deploy --dry-run");
    expect(pkg.scripts.start).toBeUndefined();
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps.wrangler).toBe("catalog:");
    for (const d of ["@hono/node-server", "tsdown", "tsx"]) expect(deps[d], d).toBeUndefined();
    expect(deps.hono).toBe("catalog:");
    const root = await (await cf()).read("pnpm-workspace.yaml");
    expect(root).toMatch(/^ {2}"wrangler": /m);
    expect(root).not.toMatch(/node-server|tsdown|tsx/);
    expect(root).toContain("  workerd: true\n");
  });

  it("generates Workers types before typecheck, gitignored and outside the repo's checks", async () => {
    const repo = await cf();
    expect(await repo.read("apps/api/tsconfig.json")).toContain("worker-configuration.d.ts");
    expect(await repo.read(".gitignore")).toContain("worker-configuration.d.ts");
    expect(await (await node()).read(".gitignore")).not.toContain("worker-configuration");
    expect(await (await node()).read("apps/api/tsconfig.json")).not.toContain("worker-config");
    // `nodejs_compat` needs @types/node.
    expect(await repo.read("tsconfig.base.json")).toContain('"types": ["node"]');
    expect(await repo.read("pnpm-workspace.yaml")).toContain('"@types/node"');
  });

  it("runs the dry-run in the generated CI", async () => {
    const ci = await (await cf()).read(".github/workflows/ci.yml");
    expect(ci).toContain("deploy:dry-run");
    expect(await (await node()).read(".github/workflows/ci.yml")).not.toContain("dry-run");
  });

  it("runs api dev on wrangler dev with the worktree's Hyperdrive connection and dev registry", async () => {
    const repo = await cf();
    const pkg = await repo.json("apps/api/package.json");
    expect(pkg.scripts.dev).toBe("wrangler dev");
    const paseo = await repo.json("paseo.json");
    // Ports still come from paseo; the two worktree values come from the cloudflare-dev wrapper.
    expect(paseo.scripts.api.command).toBe(
      "node scripts/cloudflare-dev.mjs -- pnpm --filter @acme/api dev --ip 127.0.0.1 --port $PASEO_PORT",
    );
    const files = await repo.files();
    for (const f of ["scripts/cloudflare-dev.mjs", "scripts/cloudflare-dev.test.mjs"]) {
      expect(files).toContain(f);
    }
    expect(await repo.read("scripts/cloudflare-dev.mjs")).toContain(`"${HYPERDRIVE_BINDING}"`);
    expect(await repo.read("apps/api/.dev.vars.example")).toMatch(/^#/);
    expect(await repo.read(".gitignore")).toMatch(/^\.wrangler$/m);
    expect(await repo.read(".gitignore")).toMatch(/^\.dev\.vars$/m);
    const nodeFiles = await (await node()).files();
    expect(nodeFiles).not.toContain("scripts/cloudflare-dev.mjs");
    expect(nodeFiles).not.toContain("apps/api/.dev.vars.example");
    expect((await (await node()).json("paseo.json")).scripts.api.command).toContain(
      "PORT=$PASEO_PORT",
    );
  });

  it("leaves Node output without wrangler or workerd", async () => {
    const repo = await node();
    expect(await repo.read("pnpm-workspace.yaml")).not.toMatch(/wrangler|workerd/);
    expect(await repo.read("apps/api/package.json")).not.toContain("wrangler");
  });
});
