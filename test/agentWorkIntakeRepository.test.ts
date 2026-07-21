import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  createAskWorkItem,
  createDescriptionWorkItem,
  createReviewWorkItem,
  createTriageWorkItem,
  createVerificationWorkItem,
} from "../src/agentWork/intake/workItemRepository.js";

const ref = {
  owner: "o",
  repo: "r",
  prNumber: 1,
  installationId: 42,
  headSha: "sha",
} as const;

describe("createReviewWorkItem", () => {
  it("uses the shared-step conflict predicate that matches the partial index", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;

    await createReviewWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000001",
      source: "auto",
      ref,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "ON CONFLICT (resource_key, review_lens, step) WHERE review_lens <> 'ask' AND step <> 'check_run'",
      ),
      expect.arrayContaining(["o/r#1", "review"]),
    );
  });

  it("uses slash active uniqueness ON CONFLICT and skips publish on loser", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "winner-id" }] });
    const client = { query } as unknown as PoolClient;

    const result = await createReviewWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000001",
      source: "slash",
      ref,
    });

    expect(result).toEqual({ created: false, id: "winner-id" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (resource_key, type, review_lens)"),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("(payload->>'staleHeadRescheduled') IS DISTINCT FROM 'true'"),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("review_lens IS NOT DISTINCT FROM"),
      expect.any(Array),
    );
    expect(query.mock.calls.some((call) => String(call[0]).includes("publish_records"))).toBe(
      false,
    );
  });

  it("inserts publish_records when slash review create wins", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "created-id" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;

    const result = await createReviewWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000001",
      source: "slash",
      ref: { ...ref, prNumber: 2 },
    });

    expect(result).toEqual({ created: true, id: "created-id" });
    expect(query.mock.calls.some((call) => String(call[0]).includes("publish_records"))).toBe(true);
  });

  it("writes review for the single slash review mode", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "id-review" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;

    const result = await createReviewWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000010",
      source: "slash",
      ref,
    });

    expect(result).toEqual({ created: true, id: "id-review" });
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["review", "o/r#1"]));
  });
});

describe("createDescriptionWorkItem", () => {
  it("returns existing winner on slash uniqueness conflict", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "desc-winner" }] });
    const client = { query } as unknown as PoolClient;

    const result = await createDescriptionWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000002",
      source: "slash",
      ref: { ...ref, prNumber: 3, installationId: 7 },
    });

    expect(result).toEqual({ created: false, id: "desc-winner" });
  });

  it("returns plain id for auto description", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;

    const result = await createDescriptionWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000002",
      source: "auto",
      ref,
    });

    expect(typeof result).toBe("string");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO agent_work_items"),
      expect.any(Array),
    );
    expect(String(query.mock.calls[0]?.[0])).not.toContain("ON CONFLICT");
  });
});

describe("createTriageWorkItem", () => {
  it("returns created on successful slash insert", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "triage-1" }] });
    const client = { query } as unknown as PoolClient;

    const result = await createTriageWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000003",
      ref: { ...ref, prNumber: 4, installationId: 7 },
      commentId: 9,
      scope: "all",
      replyTarget: { kind: "prConversation", prNumber: 4 },
    });

    expect(result).toEqual({ created: true, id: "triage-1" });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "ON CONFLICT (resource_key, type, review_lens)",
    );
  });

  it("returns conflict winner id from unified peer select", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "triage-winner" }] });
    const client = { query } as unknown as PoolClient;

    const result = await createTriageWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000003",
      ref,
      commentId: 9,
      scope: "thread",
      replyTarget: { kind: "inlineReviewThread", prNumber: 1, inReplyToCommentId: 9 },
    });

    expect(result).toEqual({ created: false, id: "triage-winner" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain("review_lens IS NOT DISTINCT FROM");
  });
});

describe("createAskWorkItem", () => {
  it("uses ask webhook uniqueness and returns winner on conflict", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "ask-winner" }] });
    const client = { query } as unknown as PoolClient;

    const result = await createAskWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000004",
      ref,
      question: "why?",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      commentId: 3,
      commenterId: 9,
    });

    expect(result).toEqual({ created: false, id: "ask-winner" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain("ON CONFLICT (webhook_event_id)");
  });

  it("returns created id when insert wins", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "ask-1" }] });
    const client = { query } as unknown as PoolClient;

    const result = await createAskWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000004",
      ref,
      question: "why?",
      replyTarget: { kind: "prConversation", prNumber: 1 },
      commentId: 3,
      commenterId: 9,
    });

    expect(result).toEqual({ created: true, id: "ask-1" });
  });
});

describe("createVerificationWorkItem", () => {
  it("inserts without conflict target and returns id", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;

    const result = await createVerificationWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000005",
      ref,
    });

    expect(typeof result).toBe("string");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("ON CONFLICT");
  });

  it("persists pushBeforeSha on the verification payload when provided", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;
    const pushBeforeSha = "e".repeat(40);

    await createVerificationWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000006",
      ref,
      pushBeforeSha,
    });

    const params = query.mock.calls[0]?.[1] as unknown[];
    const payloadJson = params?.[params.length - 1];
    expect(typeof payloadJson).toBe("string");
    const payload = JSON.parse(String(payloadJson)) as { pushBeforeSha?: string };
    expect(payload.pushBeforeSha).toBe(pushBeforeSha);
  });
});
