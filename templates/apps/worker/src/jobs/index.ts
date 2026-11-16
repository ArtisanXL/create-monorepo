import { healthcheck } from "./healthcheck.ts";

/** Each job: queue name + optional cron + handler. Handlers only call core. */
export const jobs = [healthcheck];
