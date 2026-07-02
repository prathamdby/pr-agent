import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createReviewWorkItem } from "../src/agentWork/intake/workItemRepository.js";

describe("createReviewWorkItem", () => {
  it("uses the shared-step conflict predicate that matches the partial index", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
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
});
