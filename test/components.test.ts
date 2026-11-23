import { describe, expect, it } from "vitest";
import {
  closureOf,
  componentsNeededBy,
  FULL_CLOSURE,
  FULL_SELECTION,
  isGenerated,
  selectionOf,
} from "../src/components.ts";

const names = (apps: string[], packages: string[] = []) => [
  ...closureOf({ apps: apps as never, packages: packages as never }),
];

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
    expect(componentsNeededBy("turbo.json")).toEqual([]);
  });

  it("keeps worktree machinery out of a Closure without db", () => {
    const closure = closureOf({ apps: ["web"], packages: [] });
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
