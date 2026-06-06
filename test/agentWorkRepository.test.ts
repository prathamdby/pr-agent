import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Pool } from "pg";

vi.mock("../src/db/postgres.js", () => ({
  queryOne: vi.fn(),
}));

import { queryOne } from "../src/db/postgres.js";
import { loadReviewExecutorPublishContext } from "../src/agentWork/repository.js";

const pool = {} as Pool;

describe("loadReviewExecutorPublishContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps one batched publish_records query into executor context", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      current_publish: [
        { step: "inline_review", github_id: "42" },
        { step: "summary_comment", github_id: "99" },
      ],
      prior_summary_exists: true,
      fingerprint_details: [{ detail: { fingerprints: ["fp-1", "fp-2"] } }],
      latest_summary_github_id: "1001",
    });

    await expect(
      loadReviewExecutorPublishContext(pool, "wi-1", "o/r#1", "review"),
    ).resolves.toEqual({
      publishState: {
        inlinePublished: true,
        summaryPublished: true,
        inlineReviewId: 42,
      },
      shouldLinkToSummary: true,
      storedInlineFingerprints: ["fp-1", "fp-2"],
      summaryCommentGithubId: 1001,
    });

    expect(queryOne).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryOne).mock.calls[0]?.[1]).toContain("json_agg");
    expect(vi.mocked(queryOne).mock.calls[0]?.[2]).toEqual(["o/r#1", "review", "wi-1"]);
  });

  it("omits summary comment hint when no prior summary publish exists", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      current_publish: [],
      prior_summary_exists: false,
      fingerprint_details: [],
      latest_summary_github_id: "1001",
    });

    await expect(
      loadReviewExecutorPublishContext(pool, "wi-2", "o/r#1", "review-security"),
    ).resolves.toMatchObject({
      shouldLinkToSummary: false,
      summaryCommentGithubId: null,
    });
  });
});
