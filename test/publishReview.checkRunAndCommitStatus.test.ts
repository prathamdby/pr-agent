import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import {
  publishReviewSummaryOnly,
  type PublishReviewSummaryOnlyArgs,
} from "../src/review/publish/publishSummaryOnly.js";
import {
  publishReviewTestBaseParams,
  publishReviewTestPayload,
} from "./helpers/publishReviewTestSetup.js";
import { makeTestConfig } from "./helpers/config.js";

vi.mock("../src/github/reviewPublish.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/reviewPublish.js")>();
  const { createReviewPublishGithubMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewPublishGithubMock(actual);
});

vi.mock("../src/agentWork/repository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/publishRecordRepository.js", async () => {
  const { createAgentWorkRepositoryMock } = await import("./helpers/publishReviewTestSetup.js");
  return createAgentWorkRepositoryMock();
});

vi.mock("../src/agentWork/reviewCheckRun.js", async () => {
  const { createReviewCheckRunMock } = await import("./helpers/publishReviewTestSetup.js");
  return createReviewCheckRunMock();
});

import { setReviewCommitStatus, upsertReviewSummaryComment } from "../src/github/reviewPublish.js";
import { attachSummaryCommentCoordination } from "../src/review/publish/summaryCommentCoordination.js";
import { completeReviewCheckRun } from "../src/agentWork/reviewCheckRun.js";

const payload = publishReviewTestPayload;
const baseParams = publishReviewTestBaseParams;
const pool = {} as import("pg").Pool;

function summaryArgs(
  overrides: Partial<PublishReviewSummaryOnlyArgs> = {},
): PublishReviewSummaryOnlyArgs {
  const findings = overrides.payload?.findings ?? payload.findings;
  return {
    cfg: makeTestConfig(),
    ctx: {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "sha",
      hasDescriptionAgentBlock: false,
    },
    getToken: () => "t",
    payload,
    summaryPlacements: findings.map((finding) => ({
      finding,
      inlineLine: finding.startLine,
      inlinePosted: true,
    })),
    inlineReviewIds: [1],
    recordPublishStep: attachSummaryCommentCoordination(vi.fn(), {
      pool,
      workItemId: "wi-1",
      resourceKey: "o/r#1",
    }),
    ...overrides,
  };
}

describe("publishReviewSummaryOnly check run completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertReviewSummaryComment).mockResolvedValue({ id: 2, updated: false });
  });

  it("completes the review check as failure when published findings include P1", async () => {
    await publishReviewSummaryOnly(summaryArgs());

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        token: "t",
        owner: "o",
        repo: "r",
        prNumber: 1,
        workItemId: "wi-1",
        resourceKey: "o/r#1",
        reviewLens: "review",
        conclusion: "failure",
        summary: "1 finding",
        detailsUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      }),
    );
  });

  it("completes the review check as failure when findings are P2-only", async () => {
    await publishReviewSummaryOnly(
      summaryArgs({
        payload: {
          ...payload,
          findings: [{ ...payload.findings[0]!, severity: "P2" }],
        },
      }),
    );

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "failure",
        summary: "1 finding",
      }),
    );
  });

  it("completes the review check as success when findings are empty", async () => {
    await publishReviewSummaryOnly(
      summaryArgs({
        payload: { ...payload, findings: [] },
      }),
    );

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "success",
        summary: "no findings",
      }),
    );
  });

  it("completes the review check as success when findings are P3-only", async () => {
    await publishReviewSummaryOnly(
      summaryArgs({
        payload: {
          ...payload,
          findings: [{ ...payload.findings[0]!, severity: "P3", fixPrompt: undefined }],
        },
      }),
    );

    expect(completeReviewCheckRun).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        conclusion: "success",
        summary: "no findings",
      }),
    );
  });
});

describe("publishReviewSummaryOnly commit status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertReviewSummaryComment).mockResolvedValue({ id: 2, updated: false });
  });

  it("posts failure when published findings include P1", async () => {
    await publishReviewSummaryOnly(
      summaryArgs({
        cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
        recordPublishStep: vi.fn(async () => undefined),
      }),
    );

    expect(setReviewCommitStatus).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      "sha",
      {
        state: "failure",
        description: "1 finding",
        targetUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      },
      undefined,
    );
  });

  it("posts failure when findings are P2-only", async () => {
    const p2Payload: ReviewPayload = {
      ...payload,
      findings: [
        {
          severity: "P2",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Nit",
          detail: "Minor.",
          fixPrompt: "Fix src/x.ts line 4.",
        },
      ],
    };

    await publishReviewSummaryOnly(
      summaryArgs({
        cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
        payload: p2Payload,
        recordPublishStep: vi.fn(async () => undefined),
      }),
    );

    expect(setReviewCommitStatus).toHaveBeenCalledWith(
      "t",
      "o",
      "r",
      "sha",
      {
        state: "failure",
        description: "1 finding",
        targetUrl: "https://github.com/o/r/pull/1#issuecomment-2",
      },
      undefined,
    );
  });

  it("completes publish when commit status API throws", async () => {
    vi.mocked(setReviewCommitStatus).mockRejectedValueOnce(new Error("status api down"));

    await expect(
      publishReviewSummaryOnly(
        summaryArgs({
          cfg: { ...baseParams.cfg, features: { ...baseParams.cfg.features, commitStatus: true } },
          recordPublishStep: vi.fn(async () => undefined),
        }),
      ),
    ).resolves.toEqual({ summaryCommentId: expect.any(Number) });
  });

  it("skips commit status when flag is off", async () => {
    await publishReviewSummaryOnly(
      summaryArgs({
        recordPublishStep: vi.fn(async () => undefined),
      }),
    );

    expect(setReviewCommitStatus).not.toHaveBeenCalled();
  });
});
