import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HYPERDRIVE_BINDING,
  JOB_QUEUE_ADR,
  type Runtime,
  type Selection,
} from "../src/components.ts";
import { scaffoldFixture } from "./support/fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function generate(selection: Selection, runtime: Runtime) {
  const { dir, cleanup } = await scaffoldFixture({ selection, runtime });
  cleanups.push(cleanup);
  const read = (rel: string) => readFile(join(dir, rel), "utf8");
  return { read, arch: async () => JSON.parse(await read("architecture.json")) };
}

const API: Selection = { apps: ["api"], packages: [] };
const LIBRARY: Selection = { apps: [], packages: ["domain", "contracts"] };
const ADR = "docs/adr/0005-runtime-cloudflare-workers.md";

describe("generated ADR-0005 (runtime: Cloudflare Workers)", () => {
  it("exists in cloudflare output with an App, and never in node output", async () => {
    const adr = await (await generate(API, "cloudflare")).read(ADR);
    expect(adr).toMatch(/^# 0005\. Runtime: Cloudflare Workers/);
    expect(adr).toContain("- Status: accepted");
    await expect((await generate(API, "node")).read(ADR)).rejects.toThrow(/ENOENT/);
  });

  it("is not written for a packages-only Selection, which has no Cloudflare files", async () => {
    await expect((await generate(LIBRARY, "cloudflare")).read(ADR)).rejects.toThrow(/ENOENT/);
  });

  it("records Hyperdrive, nodejs_compat, the dry-run and that agents never deploy", async () => {
    const adr = await (await generate(API, "cloudflare")).read(ADR);
    expect(adr).toContain("Hyperdrive");
    expect(adr).toContain(HYPERDRIVE_BINDING);
    expect(adr).toContain("nodejs_compat");
    expect(adr).toContain("compatibility_date");
    expect(adr).toMatch(/agents never deploy/i);
    expect(adr).toContain("wrangler deploy --dry-run");
    expect(adr).not.toMatch(/__[A-Z_]+__|^@(if|else|endif)/m);
  });

  it("describes Queues and the service binding only when worker and web are in the Closure", async () => {
    const adr = await (await generate(API, "cloudflare")).read(ADR);
    expect(adr).not.toMatch(/Queues|service binding|Cron/);
    const full = await (
      await generate({ apps: ["api", "web", "worker"], packages: [] }, "cloudflare")
    ).read(ADR);
    expect(full).toMatch(/Queues/);
    expect(full).toMatch(/service binding/);
  });
});

describe("package-boundaries ADR narrowed by Runtime", () => {
  it("mentions the per-request Hyperdrive client on cloudflare only", async () => {
    const path = "docs/adr/0001-package-boundaries.md";
    const cf = await (await generate(API, "cloudflare")).read(path);
    const node = await (await generate(API, "node")).read(path);
    expect(cf).toContain("Hyperdrive");
    expect(node).not.toMatch(/Hyperdrive|Cloudflare/);
  });
});

describe("architecture.json follows the Runtime", () => {
  const deferredOf = async (s: Selection, r: Runtime) =>
    Object.fromEntries(
      (await (await generate(s, r)).arch()).deferred.map((d: { name: string; deps: string[] }) => [
        d.name,
        d.deps,
      ]),
    ) as Record<string, string[]>;

  it("lists Cloudflare-correct deps for deferred Apps", async () => {
    const cf = await deferredOf(LIBRARY, "cloudflare");
    expect(cf.api).toEqual(["hono", "@hono/zod-validator"]);
    expect(cf.web).toContain("@cloudflare/vite-plugin");
    expect(cf.worker).toEqual([]);
    expect(Object.values(cf).flat()).not.toContain("@hono/node-server");
    expect(Object.values(cf).flat()).not.toContain("pg-boss");
  });

  it("keeps the Node deps for node", async () => {
    const node = await deferredOf(LIBRARY, "node");
    expect(node.api).toContain("@hono/node-server");
    expect(node.worker).toEqual(["pg-boss"]);
  });

  it("words the api role for Workers on cloudflare only", async () => {
    const role = async (r: Runtime) =>
      (await (await generate(API, r)).arch()).packages["apps/api"].role as string;
    expect(await role("cloudflare")).toContain("Cloudflare Worker");
    expect(await role("node")).not.toContain("Cloudflare");
  });

  it("names the job-queue ADR by Runtime (seam for the worker ticket)", () => {
    expect(JOB_QUEUE_ADR.node).toBe("docs/adr/0003-job-queue-pg-boss.md");
    expect(JOB_QUEUE_ADR.cloudflare).toBe("docs/adr/0003-job-queue-cloudflare-queues.md");
  });
});

describe("CLAUDE.md block, cloudflare variant", () => {
  it("shows the dry-run, and that humans deploy", async () => {
    const block = await (await generate(API, "cloudflare")).read("CLAUDE.md");
    expect(block).toContain("deploy:dry-run");
    expect(block).toMatch(/humans/i);
    expect(block).toContain(ADR);
    expect(block).not.toMatch(/__[A-Z_]+__/);
  });

  it("is unchanged for node and for packages-only cloudflare", async () => {
    expect(await (await generate(API, "node")).read("CLAUDE.md")).not.toMatch(/wrangler|deploy/i);
    const lib = await (await generate(LIBRARY, "cloudflare")).read("CLAUDE.md");
    expect(lib).not.toMatch(/wrangler|deploy/i);
  });
});
