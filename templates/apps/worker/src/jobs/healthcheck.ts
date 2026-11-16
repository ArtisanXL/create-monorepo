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
