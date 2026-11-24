# 0003. Cloudflare Queues for background jobs

- Status: accepted

## Decision
Use Cloudflare Queues as the job queue, with Cron Triggers for recurring jobs. A Worker cannot
hold a polling loop, so `worker` has two handlers: `scheduled()` enqueues one message per job
whose `cron` fired, and `queue()` runs the job each message names, over the `jobs` list in
`apps/worker/src/jobs/`. `worker` produces to and consumes from its own queue; `api` has no
producer binding. Both handlers read the database through Hyperdrive and create the client per
invocation. Every job with a `cron` needs the same cron in `apps/worker/wrangler.jsonc`.
Redis-based queues (`bullmq` etc.) are deferred until a measured throughput limit (see 0002).
