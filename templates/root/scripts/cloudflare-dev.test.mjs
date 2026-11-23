import { describe, expect, it } from "vitest";
import { devEnv, devRegistryPath, hyperdriveLocalEnvName } from "./cloudflare-dev.mjs";

describe("cloudflare-dev", () => {
  it("names the Hyperdrive local connection variable after the binding", () => {
    expect(hyperdriveLocalEnvName("HYPERDRIVE")).toBe(
      "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
    );
    expect(hyperdriveLocalEnvName("DB")).toBe("CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB");
  });

  it("gives each checkout its own dev registry path, stable across calls", () => {
    const a = devRegistryPath("/work/app-a");
    expect(devRegistryPath("/work/app-a")).toBe(a);
    expect(devRegistryPath("/work/app-b")).not.toBe(a);
    expect(a.startsWith("/work/app-a")).toBe(true);
  });

  it("derives the Hyperdrive connection from DATABASE_URL and the registry from the checkout", () => {
    const url = "postgres://u:p@localhost:5432/app_wt_k_123456";
    expect(devEnv({ binding: "HYPERDRIVE", databaseUrl: url, toplevel: "/work/app-a" })).toEqual({
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: url,
      CLOUDFLARE_DEV_REGISTRY_PATH: devRegistryPath("/work/app-a"),
    });
  });

  it("keeps api and web of one worktree on one registry, and two worktrees apart", () => {
    const url = "postgres://u:p@localhost:5432/app";
    const of = (toplevel) =>
      devEnv({ binding: "HYPERDRIVE", databaseUrl: url, toplevel }).CLOUDFLARE_DEV_REGISTRY_PATH;
    // Every App command of a worktree runs from its toplevel, so its Workers see each other...
    expect(of("/work/app-a")).toBe(of("/work/app-a"));
    // ...and web never finds the api Worker of another worktree.
    expect(of("/work/app-a")).not.toBe(of("/work/app-b"));
    expect(of("/work/app-b").startsWith("/work/app-a")).toBe(false);
  });

  it("refuses to start without a DATABASE_URL, so a worktree never falls back to another database", () => {
    expect(() => devEnv({ binding: "HYPERDRIVE", databaseUrl: undefined, toplevel: "/w" })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => devEnv({ binding: "HYPERDRIVE", databaseUrl: "", toplevel: "/w" })).toThrow(
      /DATABASE_URL/,
    );
  });
});
