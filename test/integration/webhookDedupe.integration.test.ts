import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { WebhookHeaders } from "../../src/agentWork/types.ts";
import * as v from "valibot";
import { insertWebhookEvent } from "../../src/state/intake.ts";
import { immediate, readRow, readRows } from "../../src/state/db.ts";
import { runRetention } from "../../src/state/retention.ts";
import { makeTestConfig } from "../helpers/config.ts";
import { openSqliteAppState } from "./db.ts";

const EVENT = "webhook-dedupe-it";

describe("webhook dedupe (sqlite integration)", () => {
  const state = openSqliteAppState();
  const db = state.db;

  afterAll(() => {
    state.close();
  });

  afterEach(() => {
    db.prepare(`DELETE FROM webhook_rejections`).run();
    db.prepare(`DELETE FROM webhook_body_replays`).run();
    db.prepare(`DELETE FROM webhook_deliveries`).run();
  });

  function headers(body: string, delivery?: string) {
    const base = { event: EVENT, rawBody: Buffer.from(body) };
    return ((pinnedReturn: WebhookHeaders) => pinnedReturn)(
      delivery ? { ...base, delivery } : base,
    );
  }

  function insert(body: string, delivery?: string) {
    return ((pinnedReturn: ReturnType<typeof insertWebhookEvent>) => pinnedReturn)(
      insertWebhookEvent(db, headers(body, delivery), "processed"),
    );
  }

  const countSchema = v.object({ count: v.number() });
  const deliveryKeySchema = v.object({ delivery_key: v.optional(v.string()) });
  const rejectionRowSchema = v.object({
    delivery_key: v.nullable(v.string()),
    metadata_json: v.string(),
  });
  const rejectionMetaSchema = v.object({
    deliveryId: v.nullable(v.string()),
    reason: v.string(),
  });

  function countRows() {
    const row = readRow(
      db.prepare(`SELECT COUNT(*) AS count FROM webhook_deliveries`).get(),
      countSchema,
    );
    return ((pinnedReturn: number) => pinnedReturn)(row?.count ?? 0);
  }

  function rejections() {
    return readRows(
      db.prepare(`SELECT delivery_key, metadata_json FROM webhook_rejections`).all(),
      rejectionRowSchema,
    ).map((row) => {
      const meta = v.parse(rejectionMetaSchema, JSON.parse(row.metadata_json));
      return { delivery_key: row.delivery_key, deliveryId: meta.deliveryId, reason: meta.reason };
    });
  }

  it("stores the first delivery id insert", () => {
    const result = insert("{}", "delivery-first");
    if (result.duplicate) throw new Error("delivery-first insert was treated as duplicate");
    const row = readRow(
      db
        .prepare(`SELECT delivery_key FROM webhook_deliveries WHERE delivery_key = ?`)
        .get(result.dedupeKey),
      deliveryKeySchema,
    );
    expect(row?.delivery_key).toBe("delivery:delivery-first");
  });

  it("dedupes repeated delivery ids", () => {
    const first = insert("{}", "delivery-1");
    const second = insert("{}", "delivery-1");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(countRows()).toBe(1);
  });

  it("dedupes identical bodies across delivery ids", () => {
    const first = insert('{"same":true}', "delivery-body-1");
    const second = insert('{"same":true}', "delivery-body-2");

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({
      duplicate: true,
      dedupeKey: expect.stringMatching(/^body:[0-9a-f]{64}$/),
    });
    expect(countRows()).toBe(1);
  });

  it("dedupes identical bodies without delivery ids", () => {
    const first = insert('{"same":true}');
    const second = insert('{"same":true}');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.dedupeKey).toBe(second.dedupeKey);
    expect(countRows()).toBe(1);
    expect(rejections()).toEqual([
      { delivery_key: first.dedupeKey, deliveryId: null, reason: "body_key" },
    ]);
  });

  it("keeps different bodies without delivery ids", () => {
    const first = insert('{"n":1}');
    const second = insert('{"n":2}');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    expect(countRows()).toBe(2);
  });

  it("records a delivery-key rejection for a repeated delivery id", () => {
    insert("{}", "delivery-race");
    const duplicate = insert("{}", "delivery-race");

    expect(duplicate.duplicate).toBe(true);
    expect(countRows()).toBe(1);
    expect(rejections()).toEqual([
      {
        delivery_key: "delivery:delivery-race",
        deliveryId: "delivery-race",
        reason: "delivery_key",
      },
    ]);
  });

  it("records a body-replay rejection for same body different delivery", () => {
    const first = insert('{"same":true}', "delivery-body-race-1");
    const duplicate = insert('{"same":true}', "delivery-body-race-2");

    expect(first.duplicate).toBe(false);
    expect(duplicate.dedupeKey).toMatch(/^body:[0-9a-f]{64}$/);
    expect(countRows()).toBe(1);
    const rows = rejections();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("body_replay");
    const accepted = readRows(
      db.prepare(`SELECT delivery_key FROM webhook_deliveries`).all(),
      deliveryKeySchema,
    );
    expect(accepted[0]?.delivery_key).toBe("delivery:delivery-body-race-1");
    const replays = db.prepare(`SELECT body_hash FROM webhook_body_replays`).all();
    expect(replays).toHaveLength(1);
  });

  it("rolls back duplicate evidence with its intake transaction", () => {
    insert('{"rollback":true}', "delivery-rollback-original");
    expect(() =>
      immediate(db, () => {
        const duplicate = insertWebhookEvent(
          db,
          headers('{"rollback":true}', "delivery-rollback-duplicate"),
          "processed",
        );
        expect(duplicate.duplicate).toBe(true);
        const evidence = db.prepare(`SELECT id FROM webhook_rejections`).all();
        expect(evidence).toHaveLength(1);
        throw new Error("rollback duplicate intake");
      }),
    ).toThrow("rollback duplicate intake");
    const evidence = db.prepare(`SELECT id FROM webhook_rejections`).all();
    expect(evidence).toHaveLength(0);
    expect(countRows()).toBe(1);
  });

  it("releases a body hash after webhook-event retention", async () => {
    const now = Date.now();
    const first = insert('{"retained":true}', "delivery-retained-old");
    if (first.duplicate) throw new Error("initial retained event was treated as duplicate");
    const duplicate = insert('{"retained":true}', "delivery-retained-duplicate");
    expect(duplicate.duplicate).toBe(true);
    const aged = now - 31 * 86_400 * 1000;
    db.prepare(`UPDATE webhook_deliveries SET created_at = ?`).run(aged);
    db.prepare(`UPDATE webhook_body_replays SET created_at = ?`).run(aged);
    db.prepare(`UPDATE webhook_rejections SET created_at = ?`).run(aged);

    await runRetention(
      db,
      makeTestConfig({
        retention: { agentWorkSeconds: 30 * 86_400, webhookEventsSeconds: 30 * 86_400 },
        agentEvents: { retentionSeconds: 0 },
      }),
      now,
    );

    const retry = insert('{"retained":true}', "delivery-retained-new");
    expect(retry.duplicate).toBe(false);
    expect(countRows()).toBe(1);
  });
});
