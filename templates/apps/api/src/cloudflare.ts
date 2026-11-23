import { createDb } from "__SCOPE__/db";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";

export default {
  async fetch(request, source, ctx) {
    const env = loadEnv(source);
    // One client per request: Workers cannot share connections across requests. Hyperdrive pools them.
    const db = createDb(env.__HYPERDRIVE_BINDING__.connectionString);
    try {
      return await createApp({ db }).fetch(request);
    } finally {
      ctx.waitUntil(db.$client.end({ timeout: 5 }));
    }
  },
} satisfies ExportedHandler<Env>;
