import { describe, expect, it } from "vitest";
import {
  closureOf,
  componentsNeededBy,
  contextOf,
  FULL_CLOSURE,
  FULL_CONTEXT,
  FULL_SELECTION,
  isGenerated,
  RUNTIME_OWNED_FILES,
  RUNTIMES,
  runtimeSupportError,
  selectionOf,
} from "../src/components.ts";
import { listTemplateFiles } from "../src/templates.ts";

const names = (apps: string[], packages: string[] = []) => [
  ...closureOf({ apps: apps as never, packages: packages as never }),
];

describe("resolution context", () => {
  it("carries the Closure and a Runtime that defaults to node", () => {
    const sel = { apps: ["api"], packages: [] } as const;
    expect(contextOf(sel)).toEqual({ closure: closureOf(sel), runtime: "node" });
    expect(contextOf(sel, "cloudflare").runtime).toBe("cloudflare");
    expect(FULL_CONTEXT).toEqual({ closure: FULL_CLOSURE, runtime: "node" });
  });
});

describe("Closure", () => {
  it("is everything for the default Selection", () => {
    expect([...FULL_CLOSURE]).toEqual([
      "api",
      "web",
      "worker",
      "domain",
      "contracts",
      "db",
      "core",
    ]);
  });

  it("adds the transitive dependencies of the Selection", () => {
    expect(names(["api"])).toEqual(["api", "domain", "contracts", "db", "core"]);
    expect(names(["worker"])).toEqual(["worker", "domain", "contracts", "db", "core"]);
    expect(names([], ["db"])).toEqual(["domain", "db"]);
  });

  it("allows zero apps: a packages-only repo", () => {
    expect(names([], ["domain", "contracts"])).toEqual(["domain", "contracts"]);
  });

  it("keeps standalone web alone, and lets packages be added but not removed", () => {
    expect(names(["web"])).toEqual(["web"]);
    expect(names(["web"], ["domain"])).toEqual(["web", "domain"]);
    expect(names(["api"], ["domain"])).toEqual(names(["api"]));
  });

  it("round-trips through selectionOf", () => {
    const closure = closureOf({ apps: ["api"], packages: [] });
    expect(closureOf(selectionOf(closure))).toEqual(closure);
    expect(closureOf(FULL_SELECTION)).toEqual(FULL_CLOSURE);
  });
});

describe("file ownership", () => {
  it("ties component folders and DB infrastructure files to their Component", () => {
    expect(componentsNeededBy("apps/api/src/app.ts")).toEqual(["api"]);
    expect(componentsNeededBy("apps/web/src/lib/api.ts")).toEqual(["web", "api"]);
    expect(componentsNeededBy("compose.yaml")).toEqual(["db"]);
    expect(componentsNeededBy("docs/adr/0003-job-queue-pg-boss.md")).toEqual(["worker"]);
    expect(componentsNeededBy("docs/adr/0003-job-queue-cloudflare-queues.md")).toEqual(["worker"]);
    expect(componentsNeededBy("turbo.json")).toEqual([]);
  });

  it("keeps worktree machinery out of a Closure without db", () => {
    const closure = contextOf({ apps: ["web"], packages: [] });
    for (const f of [
      "compose.yaml",
      ".worktreeinclude",
      "scripts/worktree.mjs",
      "scripts/worktree-lib.mjs",
      "scripts/worktree-lib.test.mjs",
      "docs/adr/0004-worktree-isolation.md",
      "apps/web/src/lib/api.ts",
    ]) {
      expect(isGenerated(f, closure), f).toBe(false);
    }
    expect(isGenerated("apps/web/src/main.tsx", closure)).toBe(true);
  });
});

describe("Runtime ownership (ADR-0005)", () => {
  const templates = listTemplateFiles();

  it("maps only paths that exist in templates", async () => {
    const dests = new Set((await templates).map((t) => t.dest));
    for (const path of Object.keys(RUNTIME_OWNED_FILES)) expect(dests.has(path), path).toBe(true);
  });

  it("gives no destination path two writers under either Runtime", async () => {
    for (const runtime of RUNTIMES) {
      const context = contextOf(FULL_SELECTION, runtime);
      const writers = new Map<string, number>();
      for (const { dest } of await templates) {
        if (isGenerated(dest, context)) writers.set(dest, (writers.get(dest) ?? 0) + 1);
      }
      for (const [dest, n] of writers) expect(n, `${runtime}: ${dest}`).toBe(1);
    }
  });

  it("only generates a runtime-owned path under its Runtime", () => {
    const owned = { ...RUNTIME_OWNED_FILES, "x/only-cf.ts": "cloudflare" } as const;
    expect(isGenerated("x/only-cf.ts", contextOf(FULL_SELECTION, "cloudflare"), owned)).toBe(true);
    expect(isGenerated("x/only-cf.ts", contextOf(FULL_SELECTION, "node"), owned)).toBe(false);
  });
});

describe("Runtime support", () => {
  it("accepts node with every Selection and cloudflare with packages only", () => {
    expect(runtimeSupportError(FULL_CLOSURE, "node")).toBeUndefined();
    expect(
      runtimeSupportError(closureOf({ apps: [], packages: ["domain", "db"] }), "cloudflare"),
    ).toBeUndefined();
  });

  it("accepts cloudflare with an api-only Closure, with or without db in it", () => {
    expect(runtimeSupportError(closureOf({ apps: ["api"], packages: [] }), "cloudflare")).toBe(
      undefined,
    );
  });

  it("accepts cloudflare with worker, alone or with api", () => {
    for (const apps of [["worker"], ["api", "worker"]] as const) {
      expect(runtimeSupportError(closureOf({ apps: [...apps], packages: [] }), "cloudflare")).toBe(
        undefined,
      );
    }
  });

  it("generates the cloudflare-dev wrapper for api or worker (web alone needs none), and for none without them", () => {
    for (const apps of [["api"], ["worker"], ["api", "web"], ["web", "worker"]] as const) {
      const context = contextOf({ apps: [...apps], packages: [] }, "cloudflare");
      expect(isGenerated("scripts/cloudflare-dev.mjs", context), apps.join()).toBe(true);
      expect(isGenerated("scripts/cloudflare-dev.test.mjs", context), apps.join()).toBe(true);
    }
    const webOnly = contextOf({ apps: ["web"], packages: [] }, "cloudflare");
    expect(isGenerated("scripts/cloudflare-dev.mjs", webOnly)).toBe(false);
    const none = contextOf({ apps: [], packages: ["db"] }, "cloudflare");
    expect(isGenerated("scripts/cloudflare-dev.mjs", none)).toBe(false);
  });

  it("accepts cloudflare with standalone web, alone or with packages", () => {
    expect(runtimeSupportError(closureOf({ apps: ["web"], packages: [] }), "cloudflare")).toBe(
      undefined,
    );
    expect(
      runtimeSupportError(closureOf({ apps: ["web"], packages: ["domain"] }), "cloudflare"),
    ).toBe(undefined);
  });

  it("accepts cloudflare with web together with api, and with worker", () => {
    for (const apps of [
      ["api", "web"],
      ["web", "worker"],
      ["api", "web", "worker"],
    ] as const) {
      expect(
        runtimeSupportError(closureOf({ apps: [...apps], packages: [] }), "cloudflare"),
        apps.join(),
      ).toBe(undefined);
    }
  });
});
