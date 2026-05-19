# Durable Agent Work Operations

## Services

- `pr-agent-web` verifies GitHub webhooks, writes durable intake rows, enqueues jobs, and returns quickly.
- `pr-agent-worker` processes acknowledgement, review, and ask queues.
- `postgres` stores pg-boss jobs plus app-owned workflow tables.

## Inspect Queue Health

Use SQL against Postgres:

```sql
select status, type, count(*) from agent_work_items group by status, type order by status, type;
select * from webhook_events order by received_at desc limit 20;
select * from publish_records order by updated_at desc limit 20;
```

Worker startup logs `agent_queue_stats` for each queue and `agent_review_queue_blocked_keys` if pg-boss reports blocked `key_strict_fifo` keys.

## Retry and Recovery

- If webhook intake cannot commit to Postgres, the web process returns `503`; redeliver from GitHub after Postgres is healthy.
- If a review fails permanently, the worker edits the review progress comment with a failure notice and records `agent_work_items.status = 'failed'`.
- If pg-boss reports blocked review keys, inspect failed jobs for `agent-work-review`, then retry or delete the failed pg-boss job after confirming the app-owned `agent_work_items` status is terminal.
- If a worker crashes mid-job, pg-boss heartbeat/expiration retries the job; publish steps are guarded by `publish_records`.

## Local Development

Start Postgres with Compose, then run the web or worker role against it:

```sh
docker compose up postgres
ROLE=web DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent pnpm dev
ROLE=worker DATABASE_URL=postgres://pr_agent:pr_agent@localhost:5432/pr_agent pnpm dev
```

