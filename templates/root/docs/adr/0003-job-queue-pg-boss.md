# 0003. pg-boss for background jobs

- Status: accepted

## Decision
Use `pg-boss` on Postgres as the job queue: no extra infrastructure (Redis), and enqueueing can
happen in the same transaction as the business write. Redis-based queues (`bullmq` etc.) are
deferred until a measured throughput limit (see 0002).
