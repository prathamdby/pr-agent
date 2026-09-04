import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { makeTestConfig } from "./helpers/config.js";
import type { CiRefreshJobData } from "../src/agentWork/types.js";
import {
  CI_REFRESH_QUEUE,
  CI_REFRESH_RETRY_ATTEMPT_LIMIT,
  CI_REFRESH_RETRY_DELAY_SECONDS,
  REVIEW_SUMMARY_SENTINEL,
} from "../src/settings/index.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import * as prSurfaceModule from "../src/github/prSurface.js";
import {
  ciRefreshAttemptOf,
  ciRefreshBossJobId,
  ciRefreshRetainSingletonKey,
  ciRefreshRetryBossJobId,
  decideCiRefreshRetain,
} from "../src/agentWork/intake/queueing.js";

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
  webhookEventId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
};

function fakeBoss(send: PgBoss["send"] = vi.fn().mockResolvedValue("job-id")) {
  return { send } as unknown as PgBoss;
}

describe("decideCiRefreshRetain", () => {
  it("retries from the first hop through the last slot before the cap", () => {
    expect(decideCiRefreshRetain(0)).toEqual({ kind: "retry", nextAttempt: 1 });
    expect(ciRefreshAttemptOf({ ...data, attempt: undefined })).toBe(0);
    expect(ciRefreshAttemptOf({ ...data, attempt: 4 })).toBe(4);
    expect(decideCiRefreshRetain(CI_REFRESH_RETRY_ATTEMPT_LIMIT - 1)).toEqual({
      kind: "retry",
      nextAttempt: CI_REFRESH_RETRY_ATTEMPT_LIMIT,
    });
  });

  it("stops at the cap so retain cannot spin", () => {
    for (let attempt = 0; attempt < CI_REFRESH_RETRY_ATTEMPT_LIMIT + 5; attempt++) {
      const decision = decideCiRefreshRetain(attempt);
      if (attempt >= CI_REFRESH_RETRY_ATTEMPT_LIMIT) {
        expect(decision).toEqual({ kind: "stop" });
      } else {
        expect(decision).toEqual({ kind: "retry", nextAttempt: attempt + 1 });
      }
    }
  });

  it("uses an attempt-scoped job id distinct from intake", () => {
    const eventId = data.webhookEventId!;
    expect(ciRefreshRetryBossJobId(eventId, 7, 1)).not.toBe(ciRefreshBossJobId(eventId, 7));
    expect(ciRefreshRetryBossJobId(eventId, 7, 1)).not.toBe(ciRefreshRetryBossJobId(eventId, 7, 2));
  });
});

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

  it("retains a refresh during an active review and patches after the review completes", async () => {
    mocks.hasActiveReviewWorkItem.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const send = vi.fn().mockResolvedValue("retry-id");
    const boss = fakeBoss(send);
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "summary body", 55);

    await executeCiRefreshJob(cfg, pool, boss, data);

    expect(mocks.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      CI_REFRESH_QUEUE,
      expect.objectContaining({ kind: "ci_refresh", headSha: "head", attempt: 1 }),
      expect.objectContaining({
        startAfter: CI_REFRESH_RETRY_DELAY_SECONDS,
        singletonKey: ciRefreshRetainSingletonKey({ ...data, attempt: 1 }),
        singletonSeconds: CI_REFRESH_RETRY_DELAY_SECONDS,
        priority: 40,
        id: ciRefreshRetryBossJobId(data.webhookEventId!, 7, 1),
      }),
    );
    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "listConversationComments"),
    ).toBe(false);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(false);

    await executeCiRefreshJob(cfg, pool, boss, { ...data, attempt: 1 });

    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "listConversationComments"),
    ).toBe(true);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(true);
  });

  it("stops silently once the retain attempt cap is exhausted", async () => {
    mocks.hasActiveReviewWorkItem.mockResolvedValue(true);
    const send = vi.fn();
    const boss = fakeBoss(send);

    await executeCiRefreshJob(cfg, pool, boss, {
      ...data,
      attempt: CI_REFRESH_RETRY_ATTEMPT_LIMIT,
    });

    expect(send).not.toHaveBeenCalled();
    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "listConversationComments"),
    ).toBe(false);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(false);
  });

  it("does not overwrite a newer head's CI cell", async () => {
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "summary body", 55);
    mocks.parseReviewMetaFromCommentBody.mockReturnValue({ headSha: "newer" });
    const send = vi.fn();
    const boss = fakeBoss(send);

    await executeCiRefreshJob(cfg, pool, boss, { ...data, headSha: "old" });

    expect(send).not.toHaveBeenCalled();
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(false);
  });

  it("refreshes summaries when no matching review work item is active", async () => {
    surfaceBundle.controls.setProgressComment(REVIEW_SUMMARY_SENTINEL, "summary body", 55);

    await executeCiRefreshJob(cfg, pool, fakeBoss(), data);

    expect(mocks.mintInstallationToken).toHaveBeenCalled();
    expect(mocks.hasActiveReviewWorkItem).toHaveBeenCalledWith(pool, "o/r#7");
    expect(
      surfaceBundle.controls.events.some((event) => event.kind === "listConversationComments"),
    ).toBe(true);
    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(true);
  });

  it("logs and returns without edits when listing comments fails", async () => {
    vi.spyOn(surfaceBundle.surface, "listConversationComments").mockRejectedValueOnce(
      new Error("rate limited"),
    );

    await expect(executeCiRefreshJob(cfg, pool, fakeBoss(), data)).resolves.toBeUndefined();

    expect(surfaceBundle.controls.events.some((event) => event.kind === "editComment")).toBe(false);
  });
});
