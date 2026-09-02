import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { makeTestConfig } from "./helpers/config.js";
import type { CiRefreshJobData } from "../src/agentWork/types.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/settings/index.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import * as prSurfaceModule from "../src/github/prSurface.js";

let surfaceBundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 7 });

const mocks = vi.hoisted(() => ({
  mintInstallationToken: vi.fn(),
  hasActiveReviewWorkItem: vi.fn(),
  buildCiSummaryForSurface: vi.fn(),
  createAgentCiSummaryAuthor: vi.fn(),
  shouldRenderCiSummaryRow: vi.fn(),
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
vi.mock("../src/review/ci/analyzeCi.js", () => ({
  buildCiSummaryForSurface: mocks.buildCiSummaryForSurface,
}));
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
    surfaceBundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 7 });
    vi.spyOn(prSurfaceModule, "createPrSurface").mockImplementation(() => surfaceBundle.surface);
    mocks.mintInstallationToken.mockResolvedValue({
      token: "tok",
      expiresAtTs: Date.now() + 60_000,
    });
    mocks.createAgentCiSummaryAuthor.mockReturnValue({});
    mocks.buildCiSummaryForSurface.mockResolvedValue({ status: "success" });
    mocks.shouldRenderCiSummaryRow.mockReturnValue(true);
    mocks.hasActiveReviewWorkItem.mockResolvedValue(false);
    mocks.parseReviewMetaFromCommentBody.mockReturnValue({ headSha: "head" });
    mocks.commentBodyHasCiSummaryCell.mockReturnValue(true);
    mocks.patchCiSummaryCellInCommentBody.mockReturnValue("patched body");
  });

  it("skips summary refresh while a matching review work item is active", async () => {
    mocks.hasActiveReviewWorkItem.mockResolvedValue(true);

    await executeCiRefreshJob(cfg, pool, data);

    expect(mocks.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "listConversationComments"),
    ).toBe(false);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(false);
  });

  it("refreshes summaries when no matching review work item is active", async () => {
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "summary body", 55);

    await executeCiRefreshJob(cfg, pool, data);

    expect(mocks.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "listConversationComments"),
    ).toBe(true);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(true);
  });
});
