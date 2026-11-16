# --- Node app helper ---------------------------------------------------------------------
node_app_files() { # $1=dir  $2=deps-json  $3=entry
  local name; name="$(basename "$1")"
  emit "$1/package.json" <<EOF
{
  "name": "__SCOPE__/$name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/$3.ts",
    "build": "tsdown",
    "start": "node --env-file-if-exists=../../.env dist/$3.mjs",
    "typecheck": "tsc -p ."
  },
  "dependencies": $2,
  "devDependencies": { "tsdown": "catalog:", "tsx": "catalog:" }
}
EOF
  emit "$1/tsconfig.json" <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "*.config.ts"]
}
EOF
  emit "$1/tsdown.config.ts" <<EOF
import { defineConfig } from "tsdown";

// Workspace packages are consumed as source, so they are bundled into the output.
export default defineConfig({
  entry: ["src/$3.ts"],
  platform: "node",
  format: "esm",
  outDir: "dist",
  noExternal: [/^__SCOPE_RE__\\//],
});
EOF
  emit "$1/src/env.ts" <<'EOF'
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
});

export type Env = z.infer<typeof Env>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
EOF
}

# --- apps/api ----------------------------------------------------------------------------
node_app_files apps/api '{
    "__SCOPE__/contracts": "workspace:*",
    "__SCOPE__/core": "workspace:*",
    "__SCOPE__/db": "workspace:*",
    "@hono/node-server": "catalog:",
    "@hono/zod-validator": "catalog:",
    "hono": "catalog:",
    "zod": "catalog:"
  }' server

emit apps/api/src/index.ts <<'EOF'
// The web app uses this type only via `import type` (hc<AppType>).
export type { AppType } from "./app.ts";
EOF
emit apps/api/src/app.ts <<'EOF'
import { FormatPriceRequest } from "__SCOPE__/contracts";
import { checkHealth, formatPrice } from "__SCOPE__/core";
import type { Db } from "__SCOPE__/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

export interface AppDeps {
  db: Db;
}

/** HTTP layer: validation + core calls only. No business rules here. */
export function createApp({ db }: AppDeps) {
  return new Hono()
    .basePath("/api")
    .get("/health", async (c) => c.json(await checkHealth(db)))
    .post("/format-price", zValidator("json", FormatPriceRequest), (c) =>
      c.json(formatPrice(c.req.valid("json"))),
    );
}

export type AppType = ReturnType<typeof createApp>;
EOF
emit apps/api/src/server.ts <<'EOF'
import { createDb } from "__SCOPE__/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = createApp({ db });

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`api → http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void db.$client.end({ timeout: 5 }).finally(() => process.exit(0));
  });
}
EOF
emit apps/api/src/app.test.ts <<'EOF'
import type { Db } from "__SCOPE__/db";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const downDb = {
  execute: () => Promise.reject(new Error("no connection")),
} as unknown as Db;

describe("api", () => {
  const app = createApp({ db: downDb });

  it("reports degraded when the DB is unreachable", async () => {
    const res = await app.request("/api/health");
    expect(await res.json()).toEqual({ status: "degraded", db: "down" });
  });

  it("formats a price", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "123456", currency: "USD", locale: "en-US" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ formatted: "$1,234.56" });
  });

  it("rejects invalid input via the contracts schema", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "12.5", currency: "USD" }),
    });
    expect(res.status).toBe(400);
  });
});
EOF

# --- apps/worker -------------------------------------------------------------------------
node_app_files apps/worker '{
    "__SCOPE__/core": "workspace:*",
    "__SCOPE__/db": "workspace:*",
    "pg-boss": "catalog:",
    "zod": "catalog:"
  }' worker
emit apps/worker/src/index.ts <<'EOF'
export { jobs } from "./jobs/index.ts";
EOF
emit apps/worker/src/jobs/index.ts <<'EOF'
import { healthcheck } from "./healthcheck.ts";

/** Each job: queue name + optional cron + handler. Handlers only call core. */
export const jobs = [healthcheck];
EOF
emit apps/worker/src/jobs/healthcheck.ts <<'EOF'
import { checkHealth } from "__SCOPE__/core";
import type { Db } from "__SCOPE__/db";

export const healthcheck = {
  name: "healthcheck",
  cron: "*/5 * * * *",
  async handle(db: Db): Promise<void> {
    const result = await checkHealth(db);
    console.log("healthcheck", result);
  },
};
EOF
emit apps/worker/src/worker.ts <<'EOF'
import { createDb } from "__SCOPE__/db";
import { PgBoss } from "pg-boss";
import { loadEnv } from "./env.ts";
import { jobs } from "./jobs/index.ts";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const boss = new PgBoss(env.DATABASE_URL);
boss.on("error", (error) => console.error("pg-boss", error));

await boss.start();
for (const job of jobs) {
  await boss.createQueue(job.name);
  await boss.work(job.name, async () => job.handle(db));
  if (job.cron) await boss.schedule(job.name, job.cron);
}
console.log(`worker → listening on ${jobs.length} queue(s)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void boss
      .stop()
      .then(() => db.$client.end({ timeout: 5 }))
      .finally(() => process.exit(0));
  });
}
EOF

