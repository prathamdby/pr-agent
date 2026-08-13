import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { makeTestConfig } from "./helpers/config.js";
import type { CiRefreshJobData } from "../src/agentWork/types.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/settings/index.js";
import {
  createFakePrSurface,
  resetCreatePrSurface,
  setCreatePrSurface,
} from "../src/github/prSurface.js";
import { executeCiRefreshJob } from "../src/agentWork/executors/ciRefreshExecutor.js";
import * as durableJob from "../src/agentWork/durableJob.js";
import * as repo from "../src/agentWork/repository.js";
import * as analyzeCi from "../src/review/ci/analyzeCi.js";
import * as authorCiSummary from "../src/review/ci/authorCiSummary.js";
import * as renderCiSummary from "../src/review/ci/renderCiSummary.js";
import * as reviewMetaParse from "../src/review/ci/reviewMetaParse.js";

const cfg = makeTestConfig();
const pool = new Pool({ connectionString: "postgres://127.0.0.1:1/unused" });
const data: CiRefreshJobData = {
  kind: "ci_refresh",
  installationId: 42,
  owner: "o",
  repo: "r",
  prNumber: 7,
  headSha: "head",
};

let surfaceBundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 7 });

describe("executeCiRefreshJob", () => {
  beforeEach(() => {
    surfaceBundle = createFakePrSurface({ owner: "o", repo: "r", prNumber: 7 });
    setCreatePrSurface(() => surfaceBundle.surface);
    vi.spyOn(durableJob, "mintInstallationToken").mockResolvedValue({
      token: "tok",
      expiresAtTs: Date.now() + 60_000,
      ttlMs: 60_000,
    });
    vi.spyOn(repo, "hasActiveReviewWorkItem").mockResolvedValue(false);
    vi.spyOn(authorCiSummary, "createAgentCiSummaryAuthor").mockReturnValue(async () => null);
    vi.spyOn(analyzeCi, "buildCiSummaryForSurface").mockResolvedValue({
      status: "passing",
      headline: "ok",
      failures: [],
    });
    vi.spyOn(renderCiSummary, "shouldRenderCiSummaryRow").mockReturnValue(true);
    vi.spyOn(renderCiSummary, "commentBodyHasCiSummaryCell").mockReturnValue(true);
    vi.spyOn(renderCiSummary, "patchCiSummaryCellInCommentBody").mockReturnValue("patched body");
    vi.spyOn(reviewMetaParse, "parseReviewMetaFromCommentBody").mockReturnValue({
      headSha: "head",
      lens: "review",
      stale: false,
    });
  });

  afterEach(() => {
    resetCreatePrSurface();
    vi.restoreAllMocks();
  });

  it("skips summary refresh while a matching review work item is active", async () => {
    vi.mocked(repo.hasActiveReviewWorkItem).mockResolvedValue(true);

    await executeCiRefreshJob(cfg, pool, data);

    expect(repo.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "findProgressComment"),
    ).toBe(false);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(false);
  });

  it("refreshes summaries when no matching review work item is active", async () => {
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "summary body", 55);

    await executeCiRefreshJob(cfg, pool, data);

    expect(repo.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "findProgressComment"),
    ).toBe(true);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(true);
  });
});
