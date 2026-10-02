import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DeliveryTx } from "../../src/agentWork/intake/delivery.js";
function insertWebhookEvent(
  client: import("pg").PoolClient,
  headers: import("../../src/agentWork/types.js").WebhookHeaders,
  decision: string,
) {
  return new DeliveryTx(client, headers).insert(decision);
}
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
    await pool.query("DELETE FROM webhook_delivery_duplicates WHERE event_name = $1", [EVENT]);
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
    const { rows } = await pool.query(
      `SELECT delivery_id, dedupe_key, dedupe_reason
         FROM webhook_delivery_duplicates WHERE event_name = $1`,
      [EVENT],
    );
    expect(rows).toEqual([
      { delivery_id: null, dedupe_key: first.dedupeKey, dedupe_reason: "body_key" },
    ]);
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
    const { rows } = await pool.query(
      `SELECT delivery_id, dedupe_reason FROM webhook_delivery_duplicates WHERE event_name = $1`,
      [EVENT],
    );
    expect(rows).toEqual([{ delivery_id: "delivery-race", dedupe_reason: "delivery_key" }]);
  });

  it("lets only one concurrent same-body different-delivery insert win", async () => {
    const results = await Promise.all([
      insert('{"same":true}', "delivery-body-race-1"),
      insert('{"same":true}', "delivery-body-race-2"),
    ]);

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    const duplicates = results.filter((result) => result.duplicate);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.dedupeKey).toMatch(/^body:[0-9a-f]{64}$/);
    await expect(countRows()).resolves.toBe(1);
    const { rows } = await pool.query<{ delivery_id: string; dedupe_reason: string }>(
      `SELECT delivery_id, dedupe_reason FROM webhook_delivery_duplicates WHERE event_name = $1`,
      [EVENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupe_reason).toBe("body_replay");
    const accepted = await pool.query<{ delivery_id: string }>(
      "SELECT delivery_id FROM webhook_events WHERE event_name = $1",
      [EVENT],
    );
    expect([rows[0]?.delivery_id, accepted.rows[0]?.delivery_id].toSorted()).toEqual([
      "delivery-body-race-1",
      "delivery-body-race-2",
    ]);
    const replays = await pool.query(
      `SELECT r.body_sha256 FROM webhook_event_replays r
         JOIN webhook_events e ON e.id = r.webhook_event_id WHERE e.event_name = $1`,
      [EVENT],
    );
    expect(replays.rows).toHaveLength(1);
  });

  it("rolls back duplicate evidence with its intake transaction", async () => {
    await insert('{"rollback":true}', "delivery-rollback-original");
    await expect(
      inTransaction(pool, async (client) => {
        const duplicate = await insertWebhookEvent(
          client,
          headers('{"rollback":true}', "delivery-rollback-duplicate"),
          "processed",
        );
        expect(duplicate.duplicate).toBe(true);
        const evidence = await client.query(
          "SELECT id FROM webhook_delivery_duplicates WHERE event_name = $1",
          [EVENT],
        );
        expect(evidence.rows).toHaveLength(1);
        throw new Error("rollback duplicate intake");
      }),
    ).rejects.toThrow("rollback duplicate intake");
    const evidence = await pool.query(
      "SELECT id FROM webhook_delivery_duplicates WHERE event_name = $1",
      [EVENT],
    );
    expect(evidence.rows).toHaveLength(0);
    await expect(countRows()).resolves.toBe(1);
  });

  it("releases a body hash after webhook-event retention", async () => {
    const first = await insert('{"retained":true}', "delivery-retained-old");
    if (first.duplicate) throw new Error("initial retained event was treated as duplicate");
    const duplicate = await insert('{"retained":true}', "delivery-retained-duplicate");
    expect(duplicate.duplicate).toBe(true);
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
    const evidence = await pool.query(
      "SELECT delivery_id FROM webhook_delivery_duplicates WHERE event_name = $1",
      [EVENT],
    );
    expect(evidence.rows).toEqual([{ delivery_id: "delivery-retained-duplicate" }]);
  });
});
