import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { insertWebhookEvent } from "../../src/agentWork/intake/webhookEvents.js";
import type { WebhookHeaders } from "../../src/agentWork/types.js";
import { runMigrations } from "../../src/db/migrations.js";
import { hasDatabase, integrationPool } from "./db.js";

const EVENT = "webhook-dedupe-it";

describe.skipIf(!hasDatabase)("webhook dedupe (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = integrationPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM webhook_events WHERE event_name = $1", [EVENT]);
  });

  function headers(body: string, delivery?: string): WebhookHeaders {
    const base = { event: EVENT, rawBody: Buffer.from(body) };
    return delivery ? { ...base, delivery } : base;
  }

  async function countRows(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM webhook_events WHERE event_name = $1",
      [EVENT],
    );
    return Number(rows[0]?.count ?? "0");
  }

  it("stores the first delivery id insert", async () => {
    const result = await insertWebhookEvent(pool, headers("{}", "delivery-first"), "processed");

    if (result.duplicate) throw new Error("delivery-first insert was treated as duplicate");
    const { rows } = await pool.query<{ delivery_id: string | null }>(
      "SELECT delivery_id FROM webhook_events WHERE id = $1",
      [result.id],
    );
    expect(rows[0]?.delivery_id).toBe("delivery-first");
  });

  it("dedupes repeated delivery ids", async () => {
    const first = await insertWebhookEvent(pool, headers("{}", "delivery-1"), "processed");
    const second = await insertWebhookEvent(pool, headers("{}", "delivery-1"), "processed");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    await expect(countRows()).resolves.toBe(1);
  });

  it("dedupes identical bodies without delivery ids", async () => {
    const first = await insertWebhookEvent(pool, headers('{"same":true}'), "processed");
    const second = await insertWebhookEvent(pool, headers('{"same":true}'), "processed");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.dedupeKey).toBe(second.dedupeKey);
    await expect(countRows()).resolves.toBe(1);
  });

  it("keeps different bodies without delivery ids", async () => {
    const first = await insertWebhookEvent(pool, headers('{"n":1}'), "processed");
    const second = await insertWebhookEvent(pool, headers('{"n":2}'), "processed");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    await expect(countRows()).resolves.toBe(2);
  });

  it("lets only one concurrent same-key insert win", async () => {
    const results = await Promise.all([
      insertWebhookEvent(pool, headers("{}", "delivery-race"), "processed"),
      insertWebhookEvent(pool, headers("{}", "delivery-race"), "processed"),
    ]);

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    await expect(countRows()).resolves.toBe(1);
  });
});
