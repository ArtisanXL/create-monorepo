import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPATIBILITY_DATE, HYPERDRIVE_BINDING, type Selection } from "../src/components.ts";
import { scaffoldFixture } from "./support/fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

interface Config {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  hyperdrive?: { binding: string }[];
  queues?: {
    producers?: { binding: string; queue: string }[];
    consumers?: { queue: string }[];
  };
  triggers?: { crons?: string[] };
  services?: { binding: string; service: string }[];
  dev?: { inspector_port?: number };
}

/** `wrangler deploy --dry-run` accepts mismatched names, so this reads the configs together. */
async function cloudflareRepo(selection: Selection, dbPrefix?: string) {
  const { dir, cleanup } = await scaffoldFixture({
    selection,
    runtime: "cloudflare",
    ...(dbPrefix ? { dbPrefix } : {}),
  });
  cleanups.push(cleanup);
  const read = (rel: string) => readFile(join(dir, rel), "utf8");
  const configs: Record<string, Config> = {};
  for (const app of await readdir(join(dir, "apps"))) {
    const text = await read(`apps/${app}/wrangler.jsonc`).catch(() => undefined);
    if (text === undefined) continue;
    configs[app] = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  }
  return { read, configs };
}

const WORKERS: Selection = { apps: ["api", "worker"], packages: [] };

describe("Cloudflare binding consistency", () => {
  it("gives every config the generator's compatibility date and nodejs_compat", async () => {
    const { configs } = await cloudflareRepo(WORKERS);
    expect(Object.keys(configs).sort()).toEqual(["api", "worker"]);
    for (const [app, config] of Object.entries(configs)) {
      expect(config.compatibility_date, app).toBe(COMPATIBILITY_DATE);
      expect(config.compatibility_flags, app).toContain("nodejs_compat");
    }
  });

  it("names the Hyperdrive binding the same in every config, entry and env", async () => {
    const { configs, read } = await cloudflareRepo(WORKERS);
    for (const [app, config] of Object.entries(configs)) {
      expect(
        config.hyperdrive?.map((h) => h.binding),
        app,
      ).toEqual([HYPERDRIVE_BINDING]);
      expect(await read(`apps/${app}/src/env.ts`), app).toContain(HYPERDRIVE_BINDING);
      expect(await read(`apps/${app}/src/cloudflare.ts`), app).toContain(
        `${HYPERDRIVE_BINDING}.connectionString`,
      );
    }
    expect(await read("scripts/cloudflare-dev.mjs")).toContain(`"${HYPERDRIVE_BINDING}"`);
  });

  it("matches the queue producer and consumer names, and reads the producer binding it declares", async () => {
    const { configs, read } = await cloudflareRepo(WORKERS);
    const { producers, consumers } = configs.worker?.queues ?? {};
    expect(producers).toHaveLength(1);
    expect(consumers).toHaveLength(1);
    expect(consumers?.[0]?.queue).toBe(producers?.[0]?.queue);
    expect(producers?.[0]?.queue).toMatch(/^[a-z][a-z0-9-]*$/);
    const binding = producers?.[0]?.binding as string;
    expect(await read("apps/worker/src/env.ts")).toContain(binding);
    expect(await read("apps/worker/src/cloudflare.ts")).toContain(`env.${binding}.`);
    // The api never produces or consumes, matching node.
    expect(configs.api?.queues).toBeUndefined();
  });

  it("schedules a cron for every job that has one, and only those", async () => {
    const { configs, read } = await cloudflareRepo(WORKERS);
    const job = await read("apps/worker/src/jobs/healthcheck.ts");
    const crons = [...job.matchAll(/cron: "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(crons.length).toBeGreaterThan(0);
    expect([...(configs.worker?.triggers?.crons ?? [])].sort()).toEqual(crons);
  });

  it("binds web to the api Worker by name, and keeps Worker and queue names free of underscores, for a prefix with one", async () => {
    const { configs } = await cloudflareRepo(
      { apps: ["api", "web", "worker"], packages: [] },
      "my_app",
    );
    expect(configs.api?.name).toBe("my-app-api");
    expect(configs.web?.services?.map((s) => s.service)).toEqual([configs.api?.name]);
    const names = [
      configs.api?.name,
      configs.web?.name,
      configs.worker?.name,
      ...(configs.web?.services ?? []).map((s) => s.service),
      ...(configs.worker?.queues?.producers ?? []).map((q) => q.queue),
      ...(configs.worker?.queues?.consumers ?? []).map((q) => q.queue),
    ];
    expect(names.filter(Boolean)).toHaveLength(6);
    for (const name of names) expect(name, String(name)).toMatch(/^my-app-[a-z-]+$/);
    expect(new Set([configs.api?.name, configs.web?.name, configs.worker?.name]).size).toBe(3);
  });

  it("runs the api and web dev servers of one worktree through the same registry wrapper", async () => {
    const { read } = await cloudflareRepo({ apps: ["api", "web"], packages: [] });
    const paseo = JSON.parse(await read("paseo.json"));
    const commands: string[] =
      JSON.stringify(paseo).match(/node scripts\/cloudflare-dev\.mjs -- [^"]+/g) ?? [];
    expect(commands.some((c) => c.includes("@acme/api dev"))).toBe(true);
    expect(commands.some((c) => c.includes("@acme/web dev"))).toBe(true);
  });

  it("gives every Worker its own debugger port, so three started at once never probe the same one", async () => {
    const { configs, read } = await cloudflareRepo({
      apps: ["api", "web", "worker"],
      packages: [],
    });
    // wrangler (api, worker) and the Vite plugin (web) each probe for a free port from 9229 when
    // none is set; started together they pick the same one and the loser dies with "Address already
    // in use" (socket "direct:1:default").
    const ports = [
      configs.api?.dev?.inspector_port,
      configs.worker?.dev?.inspector_port,
      Number((await read("apps/web/vite.config.ts")).match(/\|\| (\d+);/)?.[1]),
    ];
    for (const port of ports) expect(port).toBeGreaterThan(9229);
    expect(new Set(ports).size).toBe(3);
    expect(await read("apps/web/vite.config.ts")).toContain("inspectorPort })");
  });
});
