import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createSlashReviewRescheduleWorkItem } from "../src/agentWork/reviewReschedule.js";
import type { AgentWorkItem } from "../src/agentWork/types.js";

vi.mock("../src/agentWork/repository.js", () => ({
  getWorkItem: vi.fn(),
}));

import { getWorkItem } from "../src/agentWork/repository.js";

function makeItem(overrides: Partial<AgentWorkItem> = {}): AgentWorkItem {
  return {
    id: "parent-wi",
    webhookEventId: "ev-1",
    type: "review",
    source: "slash",
    status: "running",
    owner: "o",
    repo: "r",
    prNumber: 1,
    installationId: 42,
    headSha: "deadbeef",
    reviewLens: "review",
    resourceKey: "o/r#1",
    attemptCount: 1,
    payload: { mode: "review", source: "slash" },
    cancelRequestedAt: null,
    ...overrides,
  };
}

describe("createSlashReviewRescheduleWorkItem", () => {
  it("reuses persisted replacement id without inserting a new marker", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const pool = { query } as unknown as Pool;

    const replacementId = await createSlashReviewRescheduleWorkItem(
      pool,
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "existing-replacement",
        },
      }),
      "newhead",
    );

    expect(replacementId).toBe("existing-replacement");
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("persists marker then inserts replacement on first attempt", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ replacement_id: "generated-replacement" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;

    const replacementId = await createSlashReviewRescheduleWorkItem(pool, makeItem(), "newhead");

    expect(replacementId).toBe("generated-replacement");
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "payload->>'staleHeadReplacementWorkItemId') IS NULL",
    );
  });

  it("reuses marker from refreshed parent when concurrent update wins", async () => {
    vi.mocked(getWorkItem).mockResolvedValue(
      makeItem({
        payload: {
          mode: "review",
          source: "slash",
          staleHeadReplacementWorkItemId: "winner-replacement",
        },
      }),
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const pool = { query } as unknown as Pool;

    const replacementId = await createSlashReviewRescheduleWorkItem(pool, makeItem(), "newhead");

    expect(replacementId).toBe("winner-replacement");
    expect(getWorkItem).toHaveBeenCalledWith(pool, "parent-wi");
  });
});
