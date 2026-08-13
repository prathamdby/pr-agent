import { describe, expect, it, vi } from "vitest";
import { insertWebhookEvent } from "../src/agentWork/intake/webhookEvents.js";
import { createQueryClient } from "./helpers/fakePool.js";
import type { JsonValue } from "../src/util/jsonValue.js";

function mockClient(insertSucceeds: boolean) {
  const client = createQueryClient(
    vi.fn(async (_text: string, params?: readonly JsonValue[]) => ({
      rows: insertSucceeds ? [{ id: String(params?.[0] ?? "") }] : [],
    })),
  );
  vi.spyOn(client, "query");
  return client;
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
