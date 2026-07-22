import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { makeTestConfig } from "./helpers/config.js";
import type { CiRefreshJobData } from "../src/agentWork/types.js";

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(),
  hasActiveReviewWorkItem: vi.fn(),
  buildCiSummary: vi.fn(),
  createAgentCiSummaryAuthor: vi.fn(),
  shouldRenderCiSummaryRow: vi.fn(),
  findIssueCommentBySentinel: vi.fn(),
  updateIssueComment: vi.fn(),
  parseReviewMetaFromCommentBody: vi.fn(),
  commentBodyHasCiSummaryCell: vi.fn(),
  patchCiSummaryCellInCommentBody: vi.fn(),
}));

vi.mock("../src/agentWork/durableJob.js", () => ({
  mintInstallationToken: mocks.mintInstallationToken,
}));
vi.mock("../src/agentWork/repository.js", () => ({
  hasActiveReviewWorkItem: mocks.hasActiveReviewWorkItem,
}));
vi.mock("../src/review/ci/analyzeCi.js", () => ({ buildCiSummary: mocks.buildCiSummary }));
vi.mock("../src/review/ci/authorCiSummary.js", () => ({
  createAgentCiSummaryAuthor: mocks.createAgentCiSummaryAuthor,
}));
vi.mock("../src/review/ci/renderCiSummary.js", () => ({
  shouldRenderCiSummaryRow: mocks.shouldRenderCiSummaryRow,
  commentBodyHasCiSummaryCell: mocks.commentBodyHasCiSummaryCell,
  patchCiSummaryCellInCommentBody: mocks.patchCiSummaryCellInCommentBody,
}));
vi.mock("../src/review/ci/reviewMetaParse.js", () => ({
  parseReviewMetaFromCommentBody: mocks.parseReviewMetaFromCommentBody,
}));
vi.mock("../src/github/reviewPublish.js", () => ({
  findIssueCommentBySentinel: mocks.findIssueCommentBySentinel,
  updateIssueComment: mocks.updateIssueComment,
}));

import { executeCiRefreshJob } from "../src/agentWork/executors/ciRefreshExecutor.js";

const cfg = makeTestConfig();
const pool = {} as Pool;
const data: CiRefreshJobData = {
  kind: "ci_refresh",
  installationId: 42,
  owner: "o",
  repo: "r",
  prNumber: 7,
  headSha: "head",
};

describe("executeCiRefreshJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mintInstallationToken.mockResolvedValue({
      token: "tok",
      expiresAtTs: Date.now() + 60_000,
    });
    mocks.createAgentCiSummaryAuthor.mockReturnValue({});
    mocks.buildCiSummary.mockResolvedValue({ status: "success" });
    mocks.shouldRenderCiSummaryRow.mockReturnValue(true);
    mocks.hasActiveReviewWorkItem.mockResolvedValue(false);
    mocks.findIssueCommentBySentinel.mockResolvedValue(null);
  });

  it("skips summary refresh while a matching review work item is active", async () => {
    mocks.hasActiveReviewWorkItem.mockResolvedValue(true);

    await executeCiRefreshJob(cfg, pool, data);

    expect(mocks.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(mocks.findIssueCommentBySentinel).not.toHaveBeenCalled();
    expect(mocks.updateIssueComment).not.toHaveBeenCalled();
  });

  it("refreshes summaries when no matching review work item is active", async () => {
    await executeCiRefreshJob(cfg, pool, data);

    expect(mocks.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(mocks.findIssueCommentBySentinel).toHaveBeenCalled();
  });
});
