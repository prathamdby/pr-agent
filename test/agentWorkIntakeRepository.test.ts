import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  createDescriptionWorkItem,
  createReviewWorkItem,
  createTriageWorkItem,
} from "../src/agentWork/intake/workItemRepository.js";

describe("createReviewWorkItem", () => {
  it("uses the shared-step conflict predicate that matches the partial index", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;

    await createReviewWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000001",
      source: "auto",
      lens: "review",
      ref: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        installationId: 42,
        headSha: "sha",
      },
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
      lens: "review",
      ref: {
        owner: "o",
        repo: "r",
        prNumber: 1,
        installationId: 42,
        headSha: "sha",
      },
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
      lens: "review-security",
      ref: {
        owner: "o",
        repo: "r",
        prNumber: 2,
        installationId: 42,
        headSha: "sha",
      },
    });

    expect(result).toEqual({ created: true, id: "created-id" });
    expect(query.mock.calls.some((call) => String(call[0]).includes("publish_records"))).toBe(true);
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
      ref: {
        owner: "o",
        repo: "r",
        prNumber: 3,
        installationId: 7,
        headSha: "sha",
      },
    });

    expect(result).toEqual({ created: false, id: "desc-winner" });
  });
});

describe("createTriageWorkItem", () => {
  it("returns created on successful slash insert", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "triage-1" }] });
    const client = { query } as unknown as PoolClient;

    const result = await createTriageWorkItem(client, {
      webhookEventId: "00000000-0000-0000-0000-000000000003",
      ref: {
        owner: "o",
        repo: "r",
        prNumber: 4,
        installationId: 7,
        headSha: "sha",
      },
      commentId: 9,
      scope: "all",
      replyTarget: { kind: "prConversation", prNumber: 4 },
    });

    expect(result).toEqual({ created: true, id: "triage-1" });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "ON CONFLICT (resource_key, type, review_lens)",
    );
  });
});
