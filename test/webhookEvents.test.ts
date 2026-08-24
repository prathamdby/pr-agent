import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { insertWebhookEvent } from "../src/agentWork/intake/webhookEvents.js";

function mockClient(insertSucceeds: boolean, replaySucceeds = true) {
  const query = vi.fn(async (text: string, params: unknown[]) => {
    if (text.includes("INSERT INTO webhook_event_replays")) {
      return {
        rows: replaySucceeds ? [{ body_sha256: String(params[0]) }] : [],
      };
    }
    if (text.includes("DELETE FROM webhook_events")) return { rows: [] };
    return {
      rows: insertSucceeds ? [{ id: String(params[0]) }] : [],
    };
  });
  return { query } as unknown as PoolClient & { query: ReturnType<typeof vi.fn> };
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

  it("dedupes a body even when its delivery id changes", async () => {
    const body = Buffer.from('{"same":true}');
    const hash = "a".repeat(64);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "event-1" }] })
      .mockResolvedValueOnce({ rows: [{ body_sha256: hash }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-2" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;

    const first = await insertWebhookEvent(
      client,
      { event: "ping", delivery: "d-first", rawBody: body },
      "processed",
    );
    const second = await insertWebhookEvent(
      client,
      { event: "ping", delivery: "d-second", rawBody: body },
      "processed",
    );

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({
      duplicate: true,
      dedupeKey: expect.stringMatching(/^body:[0-9a-f]{64}$/),
    });
    expect(query).toHaveBeenCalledTimes(5);
  });
});
