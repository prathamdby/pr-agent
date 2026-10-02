import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";
import { describe, expect, it } from "vitest";
import { publishSummaryForTest } from "./helpers/reviewPublishTestHelpers.js";
import { createFindingLedger } from "../src/review/orchestrator/orchestratorTypes.js";
import { createFakePrSurface } from "../src/github/prSurface.js";
import { makeTestConfig } from "./helpers/config.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import type { ReviewFinding } from "../src/review/reviewSchema.js";
import type { InlinePlacement } from "../src/review/placement/reviewDiffPlacement.js";
import type { PrReviewComment } from "../src/github/prSurface.js";

function reviewComment(c: {
  path: string;
  line: number;
  id: number;
  url: string;
}): PrReviewComment {
  return {
    id: c.id,
    inReplyToId: null,
    pullRequestReviewId: null,
    userId: null,
    body: "",
    path: c.path,
    line: c.line,
    originalLine: c.line,
    htmlUrl: c.url,
    authorLogin: "pr-agent[bot]",
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "P1",
    file: "src/x.ts",
    startLine: 4,
    endLine: 4,
    title: "Bug",
    detail: "Bad logic.",
    fixPrompt: "Fix it.",
    ...overrides,
  };
}

function placement(
  f: ReviewFinding,
  opts: { inlinePosted?: boolean; inlineLine?: number | null } = {},
): InlinePlacement {
  const inlinePosted = opts.inlinePosted ?? true;
  return {
    finding: f,
    inlineLine: inlinePosted ? (opts.inlineLine ?? f.startLine) : null,
    inlinePosted,
  };
}

describe("published inline comment links", () => {
  it("attaches html_url for matching path and posted line", async () => {
    const f = finding();
    const placements = [placement(f)];
    const comments = [
      {
        path: "src/x.ts",
        line: 4,
        id: 99,
        url: "https://github.com/acme/widgets/pull/42#discussion_r99",
      },
    ];
    const { surface, controls } = createFakePrSurface({
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });
    controls.setReviewComments(comments.map(reviewComment));
    await publishSummaryForTest({
      cfg: makeTestConfig(),
      ctx: {
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: "abc",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: placements.map((p) => p.finding) }),
      ledger: createFindingLedger({
        accepted: placements.map((p) => ({
          kind: "posted",
          source: "review",
          placement: p,
          canonicalFingerprint: p.finding.title,
          reviewId: 1,
        })),
      }),
    });
    const body = controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body;
    expect(body).toContain("https://github.com/acme/widgets/pull/42#discussion_r99");
  });

  it("pairs multiple comments at the same anchor in placement order", async () => {
    const first = finding({ title: "First" });
    const second = finding({ title: "Second" });
    const placements = [placement(first), placement(second)];
    const comments = [
      {
        path: "src/x.ts",
        line: 4,
        id: 10,
        url: "https://github.com/acme/widgets/pull/42#discussion_r10",
      },
      {
        path: "src/x.ts",
        line: 4,
        id: 20,
        url: "https://github.com/acme/widgets/pull/42#discussion_r20",
      },
    ];
    const { surface, controls } = createFakePrSurface({
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });
    controls.setReviewComments(comments.map(reviewComment));
    await publishSummaryForTest({
      cfg: makeTestConfig(),
      ctx: {
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: "abc",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: placements.map((p) => p.finding) }),
      ledger: createFindingLedger({
        accepted: placements.map((p) => ({
          kind: "posted",
          source: "review",
          placement: p,
          canonicalFingerprint: p.finding.title,
          reviewId: 1,
        })),
      }),
    });
    const body = controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body;
    expect(body).toContain("discussion_r10");
    expect(body).toContain("discussion_r20");
    expect(body?.indexOf("discussion_r10")).toBeLessThan(body?.indexOf("discussion_r20") ?? -1);
  });

  it("leaves summary-only placements unchanged", async () => {
    const f = finding({ file: "README.md", startLine: 1, endLine: 1 });
    const placements = [placement(f, { inlinePosted: false })];
    const comments = [
      {
        path: "README.md",
        line: 1,
        id: 1,
        url: "https://github.com/acme/widgets/pull/42#discussion_r1",
      },
    ];
    const { surface, controls } = createFakePrSurface({
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
    });
    controls.setReviewComments(comments.map(reviewComment));
    await publishSummaryForTest({
      cfg: makeTestConfig(),
      ctx: {
        owner: "acme",
        repo: "widgets",
        prNumber: 42,
        headSha: "abc",
        hasDescriptionReviewMap: false,
      },
      prSurface: surface,
      payload: makeReviewPayload({ findings: placements.map((p) => p.finding) }),
      ledger: createFindingLedger({
        accepted: placements.map((p) => ({
          kind: "posted",
          source: "review",
          placement: p,
          canonicalFingerprint: p.finding.title,
          reviewId: 1,
        })),
      }),
    });
    const body = controls.getProgressComment(REVIEW_SUMMARY_SENTINEL)?.body;
    expect(body).not.toContain("discussion_r1");
  });
});
