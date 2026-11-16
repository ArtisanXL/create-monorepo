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
