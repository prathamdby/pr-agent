import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { getWorkItem } from "../src/agentWork/workItemStateRepository.js";

describe("getWorkItem", () => {
  it.each(["review-security", "review-quality", "review-tests"] as const)(
    "normalizes stored legacy review_lens %s to review",
    async (reviewLens) => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            id: "work-1",
            webhook_event_id: "event-1",
            type: "review",
            source: "slash",
            status: "queued",
            owner: "octo",
            repo: "repo",
            pr_number: 7,
            installation_id: "42",
            head_sha: "abc",
            review_lens: reviewLens,
            resource_key: "octo/repo#7",
            attempt_count: 0,
            payload: { mode: reviewLens, source: "slash" },
            cancel_requested_at: null,
          },
        ],
      });

      const item = await getWorkItem({ query } as unknown as Pool, "work-1");

      expect(item).toMatchObject({
        type: "review",
        reviewLens: "review",
        payload: { mode: "review", source: "slash" },
      });
    },
  );
});
