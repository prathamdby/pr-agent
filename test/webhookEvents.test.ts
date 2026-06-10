import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { insertWebhookEvent } from "../src/agentWork/intake/webhookEvents.js";

describe("insertWebhookEvent", () => {
  it("leaves duplicate event ids undefined", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PoolClient;

    const event = await insertWebhookEvent(
      client,
      {
        event: "issue_comment",
        delivery: "d1",
        rawBody: Buffer.from("{}"),
      },
      "slash_ask",
    );

    expect(event.duplicate).toBe(true);
    expect(event.id).toBeUndefined();
    expect(event.dedupeKey).toBe("delivery:d1");
  });
});
