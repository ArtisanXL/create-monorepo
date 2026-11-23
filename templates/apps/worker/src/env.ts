import { z } from "zod";

@if node
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
});

export type Env = z.infer<typeof Env>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
@endif
@if cloudflare
/** The body of a queue message: which job to run. */
export interface JobMessage {
  job: string;
}

const Env = z.object({
  __HYPERDRIVE_BINDING__: z.object({ connectionString: z.string().min(1) }),
  JOBS: z.custom<Queue<JobMessage>>(
    (value) => typeof (value as { send?: unknown } | null)?.send === "function",
  ),
});

export type Env = z.infer<typeof Env>;
/** `source` is the binding env a Worker handler receives. */
export const loadEnv = (source: object): Env => Env.parse(source);
@endif
