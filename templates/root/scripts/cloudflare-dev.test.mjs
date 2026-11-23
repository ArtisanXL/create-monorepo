import { describe, expect, it } from "vitest";
import {
  devEnv,
  devRegistryPath,
  hyperdriveLocalEnvName,
  inspectorPortFor,
  withInspectorPort,
} from "./cloudflare-dev.mjs";

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

  // wrangler and the Vite plugin each pick the first free inspector port from 9229 by probing, so
  // Workers started together probe the same port and the loser dies with "Address already in use".
  it("derives each Worker's inspector port from its own server port, so none are probed", () => {
    expect(inspectorPortFor(8787)).toBe(18787);
    expect(inspectorPortFor(8788)).not.toBe(inspectorPortFor(8787));
    expect(inspectorPortFor(4321)).toBe(14321);
    expect(inspectorPortFor(60000)).toBeUndefined();
    expect(inspectorPortFor(Number.NaN)).toBeUndefined();
  });

  it("adds the inspector port to a wrangler dev command that has a --port, in either spelling", () => {
    const base = ["run", "--filter", "./apps/api", "dev", "--ip", "127.0.0.1"];
    expect(withInspectorPort([...base, "--port", "8787"])).toEqual([
      ...base,
      "--port",
      "8787",
      "--inspector-port",
      "18787",
    ]);
    expect(withInspectorPort([...base, "--port=8788"]).slice(-2)).toEqual([
      "--inspector-port",
      "18788",
    ]);
  });

  it("leaves vite alone, which rejects unknown options (the web config reads the env instead)", () => {
    const vite = ["run", "--filter", "./apps/web", "dev", "--host", "127.0.0.1", "--port", "5173"];
    expect(withInspectorPort([...vite, "--strictPort"])).toEqual([...vite, "--strictPort"]);
  });

  it("leaves a command alone without a usable --port or with its own --inspector-port", () => {
    expect(withInspectorPort(["run", "dev", "--ip", "::"])).toEqual(["run", "dev", "--ip", "::"]);
    expect(withInspectorPort(["run", "dev", "--ip", "::", "--port", "x"])).toEqual([
      "run",
      "dev",
      "--ip",
      "::",
      "--port",
      "x",
    ]);
    const own = ["run", "dev", "--ip", "::", "--port", "8787", "--inspector-port", "9300"];
    expect(withInspectorPort(own)).toEqual(own);
  });
});
