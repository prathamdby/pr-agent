import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { insertWebhookEvent } from "../src/agentWork/intake/webhookEvents.js";

function mockClient(insertSucceeds: boolean) {
  return {
    query: vi.fn(async (_text: string, params: unknown[]) => ({
      rows: insertSucceeds ? [{ id: String(params[0]) }] : [],
    })),
  } as unknown as PoolClient & { query: ReturnType<typeof vi.fn> };
}

describe("insertWebhookEvent", () => {
  it("leaves duplicate event ids undefined", async () => {
    const client = mockClient(false);

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

  it("records ask slash intake with a returned event id", async () => {
    const client = mockClient(true);

    const event = await insertWebhookEvent(
      client,
      {
        event: "issue_comment",
        delivery: "d-ask",
        rawBody: Buffer.from('{"ask":true}'),
      },
      "slash_ask",
    );

    expect(event.duplicate).toBe(false);
    expect(event.id).toEqual(expect.any(String));
    expect(event.dedupeKey).toBe("delivery:d-ask");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO webhook_events"),
      expect.arrayContaining(["slash_ask", "issue_comment", "d-ask"]),
    );
  });

  it("records thread triage intake with a returned event id", async () => {
    const client = mockClient(true);

    const event = await insertWebhookEvent(
      client,
      {
        event: "issue_comment",
        delivery: "d-thread",
        rawBody: Buffer.from('{"thread":true}'),
      },
      "slash_triage",
    );

    expect(event.duplicate).toBe(false);
    expect(event.id).toEqual(expect.any(String));
    expect(event.dedupeKey).toBe("delivery:d-thread");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO webhook_events"),
      expect.arrayContaining(["slash_triage", "issue_comment", "d-thread"]),
    );
  });
});
