import { describe, expect, it } from "vitest";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  REPEAT_NO_BUGS_PREFIX,
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_BODY_MAX_CHARS,
  renderAgentFixPrompt,
  renderInlineThreadBody,
  renderRepeatNoBugsReviewBody,
  renderReviewPointerBody,
  renderReviewSummaryComment,
  SECURITY_REVIEW_POINTER_BODY,
} from "../src/agent/reviewRender.js";
import type { ReviewPayload } from "../src/agent/reviewSchema.js";
import {
  REVIEW_SUMMARY_SENTINEL,
  SECURITY_REVIEW_SUMMARY_SENTINEL,
} from "../src/agent/reviewSchema.js";
import {
  testPlacementsFromPayload,
  planInlineFromPayload,
  cachedDiffForFiles,
  cachedDiffForLines,
  testPlacements,
} from "./helpers/reviewPublishTestHelpers.js";

const ctx = {
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: "abc123def456",
  maxFindings: 8,
  summarySentinel: REVIEW_SUMMARY_SENTINEL,
};

function basePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    prCharacter: "Adds a retry wrapper around the webhook dispatcher.",
    findings: [],
    estimatedEffort: 3,
    relevantTests: "partial",
    securityConcerns: null,
    followUps: [],
    ...overrides,
  };
}

describe("renderReviewSummaryComment", () => {
  it("(a) no findings", () => {
    const body = renderReviewSummaryComment(basePayload(), {
      ...ctx,
      placements: testPlacementsFromPayload(basePayload()),
    });
    expect(body).toContain("## PR Agent Review");
    expect(body).toContain("_No findings._");
  });

  it("(b) P0 + P3 mix", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P0",
          file: "src/index.ts",
          startLine: 10,
          endLine: 12,
          title: "Null deref on empty payload",
          detail: "payload is used before guard",
          fixPrompt: "In src/index.ts lines 10-12, add a null check before dereferencing payload.",
        },
        {
          severity: "P3",
          file: "README.md",
          startLine: 1,
          endLine: 1,
          title: "Typo in heading",
          detail: "minor",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).toContain("**P0**");
    expect(body).toContain("Null deref on empty payload");
    expect(body).toContain("payload is used before guard");
    expect(body).toContain("Typo in heading");
    expect(body).toContain("Inline thread posted");
    expect(body).toContain("See inline thread for fix prompt");
    expect(body).not.toContain("<summary>Prompt to fix</summary>");
  });

  it("shows fix prompt details for summary-only findings", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Bug",
          detail: "Bad logic.",
          fixPrompt: "Fix src/x.ts line 4.",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings, { inlinePosted: false }),
    });
    expect(body).toContain("Summary only");
    expect(body).toContain("<summary>Prompt to fix</summary>");
    expect(body).toContain("Fix src/x.ts line 4.");
  });

  it("(c) securityConcerns set", () => {
    const payload = basePayload({
      securityConcerns: "Webhook secret compared without timing-safe equal.",
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).toContain("Webhook secret compared");
  });

  it("escapes pipes in prCharacter", () => {
    const payload = basePayload({ prCharacter: "Adds auth | breaks table" });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).toContain("Adds auth \\| breaks table");
  });

  it("uses security sentinel when requested", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      summarySentinel: SECURITY_REVIEW_SUMMARY_SENTINEL,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).toContain("## PR Agent Security Review");
    expect(body).not.toContain("## PR Agent Review\n");
  });

  it("escapes pipes in security and follow-ups table cells", () => {
    const payload = basePayload({
      securityConcerns: "foo | bar",
      followUps: ["baz | qux"],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).toContain("foo \\| bar");
    expect(body).toContain("baz \\| qux");
  });

  it("redacts banned finding text without replacing the entire summary body", () => {
    const payload = basePayload({
      prCharacter: "Safe overview.",
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Bug",
          detail: "Uses submitReview internally.",
          fixPrompt: "Fix it.",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload),
    });

    expect(body).toContain("Safe overview.");
    expect(body).toContain("[redacted internal details]");
    expect(body).not.toBe("[redacted internal details]");
  });
});

const inlineCtx = {
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: "abc123def456",
  maxFindings: 8,
};

describe("renderInlineThreadBody", () => {
  it("P0 with fixPrompt accordion", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P0",
        file: "src/a.ts",
        startLine: 5,
        endLine: 7,
        title: "Race on shared map",
        detail: "Concurrent writes without lock.",
        fixPrompt: "Guard the map with a mutex or use Ref.modify.",
      },
      inlineCtx,
    );
    expect(body).toMatchSnapshot();
    expect(body).toContain("<details>");
    expect(body).toContain("Prompt to fix");
    expect(body).toContain("Repository: acme/widgets");
    expect(body).toContain("[P0] @src/a.ts lines 5-7");
    expect(body).toContain("Guard the map with a mutex");
  });

  it("P1 with fixPrompt accordion", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P1",
        file: "src/b.ts",
        startLine: 1,
        endLine: 1,
        title: "Missing await",
        detail: "Promise not awaited in handler.",
        fixPrompt: "Await the promise before returning.",
      },
      inlineCtx,
    );
    expect(body).toMatchSnapshot();
  });

  it("P2 with fixPrompt accordion", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P2",
        file: "src/c.ts",
        startLine: 20,
        endLine: 22,
        title: "Off-by-one in slice",
        detail: "End index excludes last element incorrectly.",
        fixPrompt: "Adjust slice end index to include the last item.",
      },
      inlineCtx,
    );
    expect(body).toMatchSnapshot();
  });

  it("escapes triple backticks in fixPrompt inside accordion fence", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P1",
        file: "src/b.ts",
        startLine: 1,
        endLine: 1,
        title: "Fence break",
        detail: "Model returned markdown fences.",
        fixPrompt: "Wrap with ```ts and close with ```",
      },
      inlineCtx,
    );
    expect(body).toContain("\\`\\`\\`ts");
    expect(body).not.toContain("Wrap with ```ts");
  });
});

describe("renderAgentFixPrompt", () => {
  const renderCtx = {
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "abc123def456",
    maxFindings: 8,
  };

  it("includes PR metadata, fixPrompt verbatim, P3 tagging, and severity-first order", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P2",
          file: "src/b.ts",
          startLine: 20,
          endLine: 22,
          title: "Off-by-one",
          detail: "Slice excludes last item.",
          fixPrompt: "In src/b.ts lines 20-22, adjust slice end index.",
        },
        {
          severity: "P0",
          file: "src/a.ts",
          startLine: 5,
          endLine: 7,
          title: "Race on shared map",
          detail: "Concurrent writes without lock.",
          fixPrompt: "In src/a.ts lines 5-7, guard the map with a mutex.",
        },
        {
          severity: "P3",
          file: "README.md",
          startLine: 1,
          endLine: 1,
          title: "Typo in heading",
          detail: "minor typo",
        },
      ],
    });
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlineFromPayload(
        payload,
        renderCtx.maxFindings,
        cachedDiffForFiles([
          { file: "src/a.ts", lines: [5, 6, 7] },
          { file: "src/b.ts", lines: [20, 21, 22] },
        ]),
      ),
    );

    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain("Repository: acme/widgets");
    expect(prompt).toContain("Pull request: #42");
    expect(prompt).toContain("Head SHA: abc123def456");
    expect(prompt.indexOf("[P0] @src/a.ts")).toBeLessThan(prompt.indexOf("[P2] @src/b.ts"));
    expect(prompt.indexOf("[P2] @src/b.ts")).toBeLessThan(
      prompt.indexOf("[P3 — no inline thread]"),
    );
    expect(prompt).toContain("In src/a.ts lines 5-7, guard the map with a mutex.");
    expect(prompt).not.toContain("Concurrent writes without lock.");
    expect(prompt).toContain("[P3 — no inline thread] Typo in heading");
    expect(prompt).toContain("minor typo");
  });

  it("tags inline-omitted P0–P2 findings when severity cap truncates threads", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "b.ts",
          startLine: 2,
          endLine: 2,
          title: "Hidden from inline",
          detail: "d",
          fixPrompt: "Fix b.ts line 2.",
        },
        {
          severity: "P2",
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          title: "Shown inline",
          detail: "d",
          fixPrompt: "Fix a.ts line 1.",
        },
      ],
    });
    const prompt = renderAgentFixPrompt(
      payload,
      { ...renderCtx, maxFindings: 1 },
      planInlineFromPayload(payload, 1),
    );

    expect(prompt.indexOf("[P1]")).toBeLessThan(prompt.indexOf("[P2]"));
    expect(prompt).toContain("[inline thread omitted — severity cap]");
    expect(prompt.match(/\[inline thread omitted — severity cap\]/g)).toHaveLength(1);
  });

  it("uses singular line range for single-line findings", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/single.ts",
          startLine: 9,
          endLine: 9,
          title: "Missing await",
          detail: "d",
          fixPrompt: "Await the promise.",
        },
      ],
    });
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlineFromPayload(payload, renderCtx.maxFindings),
    );

    expect(prompt).toContain("@src/single.ts line 9");
    expect(prompt).not.toContain("lines 9-9");
  });

  it("tags invalid anchors as summary-only in agent fix prompt", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 99,
          endLine: 99,
          title: "Off diff",
          detail: "d",
          fixPrompt: "Fix src/x.ts line 99.",
        },
      ],
    });
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlineFromPayload(payload, renderCtx.maxFindings),
    );

    expect(prompt).toContain("[inline thread omitted — summary only]");
    expect(prompt).not.toContain("[inline thread omitted — severity cap]");
  });
});

describe("renderReviewPointerBody", () => {
  const renderCtx = {
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "abc123def456",
    maxFindings: 8,
  };

  it("redacts banned fix prompt text without removing the pointer wrapper", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Bug",
          detail: "Bad logic.",
          fixPrompt: "Call submitReview after fixing.",
        },
        {
          severity: "P2",
          file: "src/y.ts",
          startLine: 2,
          endLine: 2,
          title: "Other",
          detail: "Also bad.",
          fixPrompt: "Fix src/y.ts line 2.",
        },
      ],
    });
    const { body } = renderReviewPointerBody(payload, {
      ...renderCtx,
      mode: "review",
      placements: planInlineFromPayload(
        payload,
        renderCtx.maxFindings,
        cachedDiffForFiles([
          { file: "src/x.ts", lines: [4] },
          { file: "src/y.ts", lines: [2] },
        ]),
      ),
    });

    expect(body).toContain(REVIEW_POINTER_BODY);
    expect(body).toContain("[redacted internal details]");
    expect(body).toContain("Fix src/y.ts line 2.");
    expect(body).not.toBe("[redacted internal details]");
  });

  it("wraps agent fix prompt in accordion with pointer line", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Bug",
          detail: "Bad logic.",
          fixPrompt: "Fix src/x.ts line 4.",
        },
      ],
    });
    const { body, truncated } = renderReviewPointerBody(payload, {
      ...renderCtx,
      mode: "review",
      placements: planInlineFromPayload(
        payload,
        renderCtx.maxFindings,
        cachedDiffForLines("src/x.ts", [4]),
      ),
    });

    expect(truncated).toBe(false);
    expect(body).toMatchSnapshot();
    expect(body).toContain(REVIEW_POINTER_BODY);
    expect(body).toContain("<details>");
    expect(body).toContain(`<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`);
    expect(body).toContain("Fix src/x.ts line 4.");
  });

  it("uses security pointer line for review-security mode", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P0",
          file: "src/auth.ts",
          startLine: 1,
          endLine: 3,
          title: "Auth bypass",
          detail: "Missing check.",
          fixPrompt: "Add auth guard.",
        },
      ],
    });
    const { body } = renderReviewPointerBody(payload, {
      ...renderCtx,
      mode: "review-security",
      placements: planInlineFromPayload(payload, renderCtx.maxFindings),
    });

    expect(body).toContain(SECURITY_REVIEW_POINTER_BODY);
    expect(body).toContain("Add auth guard.");
  });

  it("uses markdown link when summaryCommentUrl is provided", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Bug",
          detail: "Bad logic.",
          fixPrompt: "Fix it.",
        },
      ],
    });
    const { body } = renderReviewPointerBody(payload, {
      ...renderCtx,
      mode: "review",
      summaryCommentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-123",
      placements: planInlineFromPayload(payload, renderCtx.maxFindings),
    });

    expect(body).toContain(
      "[View the updated review.](https://github.com/acme/widgets/pull/42#issuecomment-123)",
    );
    expect(body).not.toContain(REVIEW_POINTER_BODY);
  });

  it("truncates agent fix prompt when assembled body exceeds max chars", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/big.ts",
          startLine: 1,
          endLine: 1,
          title: "Large fix prompt",
          detail: "d",
          fixPrompt: "x".repeat(REVIEW_POINTER_BODY_MAX_CHARS),
        },
      ],
    });
    const { body, truncated } = renderReviewPointerBody(payload, {
      ...renderCtx,
      mode: "review",
      placements: planInlineFromPayload(payload, renderCtx.maxFindings),
    });

    expect(truncated).toBe(true);
    expect(body.length).toBeLessThanOrEqual(REVIEW_POINTER_BODY_MAX_CHARS);
    expect(body).toContain("...[truncated; see inline threads and PR summary]");
  });
});

describe("renderRepeatNoBugsReviewBody", () => {
  const url = "https://github.com/acme/widgets/pull/42#issuecomment-123";

  it("links to summary when URL is verified (general)", () => {
    const body = renderRepeatNoBugsReviewBody("review", url);
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}, [see the updated review](${url}).`);
  });

  it("links to summary when URL is verified (security)", () => {
    const body = renderRepeatNoBugsReviewBody("review-security", url);
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}, [see the updated security review](${url}).`);
  });

  it("falls back to plain pointer when URL is missing (general)", () => {
    const body = renderRepeatNoBugsReviewBody("review");
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}. ${REVIEW_POINTER_BODY}`);
  });

  it("falls back to plain pointer when URL is missing (security)", () => {
    const body = renderRepeatNoBugsReviewBody("review-security");
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}. ${SECURITY_REVIEW_POINTER_BODY}`);
  });
});
