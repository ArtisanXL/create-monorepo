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
