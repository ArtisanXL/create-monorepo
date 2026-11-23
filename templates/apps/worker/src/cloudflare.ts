import { createDb } from "__SCOPE__/db";
import { type JobMessage, loadEnv } from "./env.ts";
import { jobs } from "./jobs/index.ts";

export default {
  // Cron Triggers: enqueue one message per job whose `cron` fired.
  async scheduled(controller, source) {
    const env = loadEnv(source);
    const due = jobs.filter((job) => job.cron === controller.cron);
    if (due.length === 0) return;
    await env.JOBS.sendBatch(due.map((job) => ({ body: { job: job.name } })));
  },
  // Queue consumer: dispatch each message over `jobs`.
  async queue(batch, source, ctx) {
    const env = loadEnv(source);
    // One client per invocation: Workers cannot share connections across invocations. Hyperdrive pools them.
    const db = createDb(env.__HYPERDRIVE_BINDING__.connectionString);
    try {
      for (const message of batch.messages) {
        const job = jobs.find((j) => j.name === message.body.job);
        if (!job) {
          console.error("unknown job", message.body.job);
          message.ack();
          continue;
        }
        try {
          await job.handle(db);
          message.ack();
        } catch (error) {
          console.error("job failed", job.name, error);
          message.retry();
        }
      }
    } finally {
      ctx.waitUntil(db.$client.end({ timeout: 5 }));
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;
