import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { executeCiRefreshJob } from "../src/agentWork/executors/ciRefreshExecutor.js";
import type { CiRefreshJobData } from "../src/agentWork/types.js";

vi.mock("../src/agentWork/durableJob.js", () => ({
  mintInstallationToken: vi.fn(async () => ({
    token: "tok",
    expiresAtTs: Date.now() + 3_600_000,
    ttlMs: 3_600_000,
  })),
}));

vi.mock("../src/review/ci/analyzeCi.js", () => ({
  buildCiSummary: vi.fn(async () => ({
    status: "passing",
    headline: "✅ All CI is passing",
    failures: [],
  })),
}));

vi.mock("../src/review/ci/authorCiSummary.js", () => ({
  createAgentCiSummaryAuthor: vi.fn(() => undefined),
}));

vi.mock("../src/github/reviewPublish.js", () => ({
  findIssueCommentBySentinel: vi.fn(async () => ({
    id: 9,
    body: [
      "## PR Agent Review",
      "<!-- pr-agent:review-meta headSha=deadbeef lens=review stale=false -->",
      "<table><tbody><tr><td><strong>CI</strong></td><td><!-- pr-agent:ci-summary -->old<!-- /pr-agent:ci-summary --></td></tr></tbody></table>",
    ].join("\n"),
  })),
  updateIssueComment: vi.fn(async () => undefined),
}));

vi.mock("../src/agentWork/workItemStateRepository.js", () => ({
  hasActiveReviewWorkItem: vi.fn(),
}));

import { hasActiveReviewWorkItem } from "../src/agentWork/workItemStateRepository.js";
import { findIssueCommentBySentinel, updateIssueComment } from "../src/github/reviewPublish.js";
import { buildCiSummary } from "../src/review/ci/analyzeCi.js";

const cfg = {} as Config;
const pool = {} as Pool;

function jobData(): CiRefreshJobData {
  return {
    kind: "ci_refresh",
    installationId: 1,
    owner: "o",
    repo: "r",
    prNumber: 7,
    headSha: "deadbeef",
  };
}

describe("executeCiRefreshJob active-review guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveReviewWorkItem).mockResolvedValue(false);
  });

  it("skips CI cell patches while an active queued/running review work item exists", async () => {
    vi.mocked(hasActiveReviewWorkItem).mockResolvedValue(true);

    await executeCiRefreshJob(cfg, pool, jobData());

    expect(hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(buildCiSummary).not.toHaveBeenCalled();
    expect(findIssueCommentBySentinel).not.toHaveBeenCalled();
    expect(updateIssueComment).not.toHaveBeenCalled();
  });

  it("patches CI cells when no active review work item exists", async () => {
    await executeCiRefreshJob(cfg, pool, jobData());

    expect(hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(buildCiSummary).toHaveBeenCalled();
    expect(updateIssueComment).toHaveBeenCalled();
  });
});
