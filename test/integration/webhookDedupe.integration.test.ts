import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { insertWebhookEvent } from "../../src/agentWork/intake/webhookEvents.js";
import type { WebhookHeaders } from "../../src/agentWork/types.js";
import { runMigrations } from "../../src/db/migrations.js";
import { inTransaction } from "../../src/db/postgres.js";
import { runRetention } from "../../src/agentWork/retention.js";
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

  function insert(body: string, delivery?: string) {
    return inTransaction(pool, (client) =>
      insertWebhookEvent(client, headers(body, delivery), "processed"),
    );
  }

  async function countRows(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM webhook_events WHERE event_name = $1",
      [EVENT],
    );
    return Number(rows[0]?.count ?? "0");
  }

  it("stores the first delivery id insert", async () => {
    const result = await insert("{}", "delivery-first");

    if (result.duplicate) throw new Error("delivery-first insert was treated as duplicate");
    const { rows } = await pool.query<{ delivery_id: string | null }>(
      "SELECT delivery_id FROM webhook_events WHERE id = $1",
      [result.id],
    );
    expect(rows[0]?.delivery_id).toBe("delivery-first");
  });

  it("dedupes repeated delivery ids", async () => {
    const first = await insert("{}", "delivery-1");
    const second = await insert("{}", "delivery-1");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    await expect(countRows()).resolves.toBe(1);
  });

  it("dedupes identical bodies across delivery ids", async () => {
    const first = await insert('{"same":true}', "delivery-body-1");
    const second = await insert('{"same":true}', "delivery-body-2");

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({
      duplicate: true,
      dedupeKey: expect.stringMatching(/^body:[0-9a-f]{64}$/),
    });
    await expect(countRows()).resolves.toBe(1);
  });

  it("dedupes identical bodies without delivery ids", async () => {
    const first = await insert('{"same":true}');
    const second = await insert('{"same":true}');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.dedupeKey).toBe(second.dedupeKey);
    await expect(countRows()).resolves.toBe(1);
  });

  it("keeps different bodies without delivery ids", async () => {
    const first = await insert('{"n":1}');
    const second = await insert('{"n":2}');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    await expect(countRows()).resolves.toBe(2);
  });

  it("lets only one concurrent same-key insert win", async () => {
    const results = await Promise.all([
      insert("{}", "delivery-race"),
      insert("{}", "delivery-race"),
    ]);

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    await expect(countRows()).resolves.toBe(1);
  });

  it("releases a body hash after webhook-event retention", async () => {
    const first = await insert('{"retained":true}', "delivery-retained-old");
    if (first.duplicate) throw new Error("initial retained event was treated as duplicate");
    await pool.query(
      "UPDATE webhook_events SET received_at = now() - interval '31 days' WHERE id = $1",
      [first.id],
    );

    await runRetention(pool, {
      agentWorkRetentionSeconds: 30 * 86_400,
      webhookEventsRetentionSeconds: 30 * 86_400,
      agentEventsRetentionSeconds: 0,
      codeIndexRetentionSeconds: 30 * 86_400,
    });

    const retry = await insert('{"retained":true}', "delivery-retained-new");
    expect(retry.duplicate).toBe(false);
    await expect(countRows()).resolves.toBe(1);
  });
});
