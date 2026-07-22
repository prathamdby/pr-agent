import { describe, expect, it } from "vitest";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  REPEAT_NO_BUGS_PREFIX,
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_BODY_MAX_CHARS,
  REVIEW_POINTER_NOTE_LEAD,
  renderAgentFixPrompt,
  renderInlineThreadBody,
  renderLightweightReviewCompletion,
  renderRepeatNoBugsReviewBody,
  renderReviewPointerBody,
  renderReviewPointerLensMarker,
  renderReviewSummaryComment,
  renderStaleReviewMetadataComment,
  fitReviewSummaryBody,
} from "../src/review/run/reviewRender.js";
import {
  REVIEW_FINDING_FOOTNOTE_INLINE,
  REVIEW_FINDINGS_NONE,
  REVIEW_SUMMARY_BODY_MAX_CHARS,
  REVIEW_SUMMARY_COMPACTION_NOTE,
  REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX,
} from "../src/settings/index.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
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
  hasDescriptionAgentBlock: false,
  summarySentinel: REVIEW_SUMMARY_SENTINEL,
  mode: "review" as const,
  runFooter: { durationMs: 680_000, model: "grok-4.5" },
};

function basePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return makeReviewPayload({
    prCharacter: "Adds a retry wrapper around the webhook dispatcher.",
    estimatedEffort: 3,
    relevantTests: "partial",
    ...overrides,
  });
}

describe("renderReviewSummaryComment", () => {
  it("(a) no findings", () => {
    const body = renderReviewSummaryComment(basePayload(), {
      ...ctx,
      placements: testPlacementsFromPayload(basePayload()),
    });
    expect(body).toContain("## PR Agent Review");
    expect(body).toContain("[!NOTE]");
    expect(body).not.toContain("| | |");
    expect(body).toContain("<table>");
    expect(body).toContain(REVIEW_FINDINGS_NONE);
    expect(body).not.toContain("_No findings._");
    expect(body).not.toContain("### Findings");
    expect(body).toContain("<sub>abc123d ⋅ general ⋅ 11m 20s ⋅ grok-4.5</sub>");
  });

  it("renders a CI gate row when a CI summary is provided", () => {
    const body = renderReviewSummaryComment(basePayload(), {
      ...ctx,
      placements: testPlacementsFromPayload(basePayload()),
      ciSummary: {
        status: "failing",
        headline: "❌ CI failing — lint",
        failures: [
          {
            name: "lint",
            reason: "src/foo.ts:12 — Unexpected any",
            fixHint: "Fix the reported lint/format findings locally, then re-push.",
            url: "https://example.com/lint",
          },
        ],
      },
    });
    expect(body).toContain("<strong>CI</strong>");
    expect(body).toContain("CI failing");
    expect(body).toContain("Unexpected any");
    expect(body).toContain("re-push");
    // CI sits after Security in the overview gate table.
    expect(body.indexOf("<strong>Security</strong>")).toBeLessThan(
      body.indexOf("<strong>CI</strong>"),
    );
  });

  it("shows the CI gate row when Checks permission is missing", () => {
    const body = renderReviewSummaryComment(basePayload(), {
      ...ctx,
      placements: testPlacementsFromPayload(basePayload()),
      ciSummary: {
        status: "unavailable",
        headline:
          "PR Agent can't see check runs on this head. In the GitHub App settings, set Checks to Read, then run /review again.",
        failures: [],
      },
    });
    expect(body).toContain("<strong>CI</strong>");
    expect(body).toContain("Checks to Read");
  });

  it("links inline findings to review comment URLs when provided", () => {
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
    const placements = testPlacements(payload.findings).map((p) => ({
      ...p,
      inlineCommentUrl: "https://github.com/acme/widgets/pull/42#discussion_r99",
    }));
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements,
    });
    expect(body).toContain("#discussion_r99");
    expect(body).not.toContain("/blob/abc123def456/");
  });

  it("renders confidence beside severity when present", () => {
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
          confidence: 4,
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings),
    });

    expect(body).toContain("<strong>P1 · c4</strong>");
  });

  it("omits confidence label when absent", () => {
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
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings),
    });

    expect(body).toContain("<strong>P1</strong>");
    expect(body).not.toContain("c4");
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
          fixPrompt: "Fix the typo in the README heading.",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: [
        ...testPlacements([payload.findings[0]]),
        ...testPlacements([payload.findings[1]], { inlinePosted: false }),
      ],
    });
    expect(body).toContain("<strong>P0</strong>");
    expect(body).toContain("Null deref on empty payload");
    expect(body).not.toContain("payload is used before guard");
    expect(body).toContain("Typo in heading");
    expect(body).toContain("minor");
    expect(body).toContain("Summary only");
    expect(body).toContain(REVIEW_FINDING_FOOTNOTE_INLINE);
    expect(body).not.toContain("<summary>Prompt to fix</summary>");
    expect(body).toContain("<summary>Prompt to fix — P3 · Typo in heading</summary>");
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
    expect(body).toContain("<summary>Prompt to fix — P1 · Bug</summary>");
    expect(body).toContain("Fix src/x.ts line 4.");
  });

  it("escapes pipes and newlines in summary-only detail table cells", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 4,
          endLine: 4,
          title: "Bug",
          detail: "Bad | logic\nsecond line",
          fixPrompt: "Fix it.",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings, { inlinePosted: false }),
    });
    expect(body).toContain("Bad | logic second line");
    expect(body).toContain("<strong>P1</strong>");
  });

  it("escapes pipes in finding title inside table cells", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P2",
          file: "src/x.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug | typo",
          detail: "minor",
          fixPrompt: "Fix title.",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings, { inlinePosted: false }),
    });
    expect(body).toContain("Bug | typo</a>");
  });

  it("labels summary-only accordions by severity and title", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "First",
          detail: "d1",
          fixPrompt: "fix 1",
        },
        {
          severity: "P2",
          file: "src/b.ts",
          startLine: 2,
          endLine: 2,
          title: "Second",
          detail: "d2",
          fixPrompt: "fix 2",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings, { inlinePosted: false }),
    });
    expect(body).toContain("<summary>Prompt to fix — P1 · First</summary>");
    expect(body).toContain("<summary>Prompt to fix — P2 · Second</summary>");
  });

  it("HTML-escapes summary-only accordion titles", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/x.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug <script>",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings, { inlinePosted: false }),
    });
    expect(body).toContain("<summary>Prompt to fix — P1 · Bug &lt;script&gt;</summary>");
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
    expect(body).toContain("[!NOTE]");
    expect(body).toContain("Adds auth | breaks table");
  });

  it("uses the general summary identity for recognized legacy modes", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      mode: "review-security",
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).toContain("## PR Agent Review");
    expect(body).toContain("<sub>abc123d ⋅ general ⋅ 11m 20s ⋅ grok-4.5</sub>");
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
    expect(body).toContain("foo | bar");
    expect(body).toContain("baz | qux");
  });

  it("renders finding text mentioning submitReview without redaction", () => {
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
      placements: testPlacements(payload.findings, { inlinePosted: false }),
    });

    expect(body).toContain("Safe overview.");
    expect(body).toContain("Uses submitReview internally.");
    expect(body).not.toContain("[redacted internal details]");
  });

  it("compacts oversized summaries while keeping every finding title visible", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      severity: "P2" as const,
      file: `src/f${i}.ts`,
      startLine: i + 1,
      endLine: i + 1,
      title: `Bug ${i}`,
      detail: "x".repeat(5000),
      fixPrompt: "Fix it.",
    }));
    const payload = basePayload({ findings });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload, false),
    });

    expect(body.length).toBeLessThanOrEqual(REVIEW_SUMMARY_BODY_MAX_CHARS);
    for (const finding of findings) {
      expect(body).toContain(finding.title);
    }
    expect(body).toContain(REVIEW_SUMMARY_COMPACTION_NOTE);
  });

  it("drops finding rows from the tail when compact mode still exceeds the body budget", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      severity: "P2" as const,
      file: `src/f${i}.ts`,
      startLine: i + 1,
      endLine: i + 1,
      title: `Bug ${i}`,
      detail: "x".repeat(5000),
      fixPrompt: "Fix it.",
    }));
    const payload = basePayload({ findings });
    const body = fitReviewSummaryBody(
      payload,
      {
        ...ctx,
        placements: testPlacementsFromPayload(payload, false),
      },
      2_500,
    );

    expect(body.length).toBeLessThanOrEqual(2_500);
    expect(body).toContain(REVIEW_SUMMARY_COMPACTION_NOTE);
    expect(body).toContain(REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX);
    expect(body).toContain("Bug 0");
    expect(body).not.toContain("Bug 9");
    expect(body).toMatchSnapshot();
  });

  it("does not render a merge verdict row", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).not.toContain("Merge verdict");
    expect(body).not.toContain("No blocking findings on this pass");
  });

  it("does not render a blocking-count fallback when blocking findings are present", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P0",
          file: "src/x.ts",
          startLine: 1,
          endLine: 1,
          title: "Critical bug",
          detail: "d",
          fixPrompt: "fix",
        },
        {
          severity: "P1",
          file: "src/y.ts",
          startLine: 2,
          endLine: 2,
          title: "High bug",
          detail: "d",
          fixPrompt: "fix",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings),
    });
    expect(body).not.toContain("blocking finding");
    expect(body).not.toContain("Blocking finding");
  });

  it("appends description link when hasDescriptionAgentBlock is true", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      hasDescriptionAgentBlock: true,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).toContain(
      "See the [file walkthrough](https://github.com/acme/widgets/pull/42) in the PR description.",
    );
  });

  it("omits description link when hasDescriptionAgentBlock is false", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacementsFromPayload(payload),
    });
    expect(body).not.toContain("file walkthrough");
  });
});

const inlineCtx = {
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: "abc123def456",
  hasDescriptionAgentBlock: false,
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

  it("renders single-line suggestedCode as a suggestion fence", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P1",
        file: "src/b.ts",
        startLine: 1,
        endLine: 1,
        title: "Missing await",
        detail: "Promise not awaited in handler.",
        fixPrompt: "Await the promise before returning.",
        suggestedCode: "return await run();",
      },
      inlineCtx,
    );

    expect(body).toContain("```suggestion\nreturn await run();\n```");
  });

  it("does not render suggestedCode for multi-line anchors", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P1",
        file: "src/b.ts",
        startLine: 1,
        endLine: 2,
        title: "Missing await",
        detail: "Promise not awaited in handler.",
        fixPrompt: "Await the promise before returning.",
        suggestedCode: "return await run();",
      },
      inlineCtx,
    );

    expect(body).not.toContain("```suggestion");
  });

  it("drops suggestedCode when it contains a fence breaker", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P1",
        file: "src/b.ts",
        startLine: 1,
        endLine: 1,
        title: "Fence break",
        detail: "Model returned markdown fences.",
        fixPrompt: "Replace the return statement.",
        suggestedCode: "return ```literal```;",
      },
      inlineCtx,
    );

    expect(body).not.toContain("```suggestion");
    expect(body).not.toContain("\\`\\`\\`literal");
  });
});

describe("renderAgentFixPrompt", () => {
  const renderCtx = {
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "abc123def456",
    hasDescriptionAgentBlock: false,
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
          fixPrompt: "Fix the typo in the README heading.",
        },
      ],
    });
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlineFromPayload(
        payload,
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
    expect(prompt.indexOf("[P2] @src/b.ts")).toBeLessThan(prompt.indexOf("[P3] @README.md"));
    expect(prompt).toContain("In src/a.ts lines 5-7, guard the map with a mutex.");
    expect(prompt).not.toContain("Concurrent writes without lock.");
    expect(prompt).toContain("[P3] @README.md line 1");
    expect(prompt).toContain("Fix the typo in the README heading.");
    expect(prompt).toContain("[inline thread omitted — summary only]");
    expect(prompt).not.toContain("minor typo");
  });

  it("tags unanchored P0–P2 findings as summary-only in agent fix prompt", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "b.ts",
          startLine: 2,
          endLine: 2,
          title: "Anchored inline",
          detail: "d",
          fixPrompt: "Fix b.ts line 2.",
        },
        {
          severity: "P2",
          file: "a.ts",
          startLine: 99,
          endLine: 99,
          title: "Off diff",
          detail: "d",
          fixPrompt: "Fix a.ts line 99.",
        },
      ],
    });
    const diffIndex = cachedDiffForFiles([{ file: "b.ts", lines: [2] }]);
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlineFromPayload(payload, diffIndex),
    );

    expect(prompt.indexOf("[P1]")).toBeLessThan(prompt.indexOf("[P2]"));
    expect(prompt).toContain("[inline thread omitted — summary only]");
    expect(prompt).not.toContain("[inline thread omitted — severity cap]");
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
    const prompt = renderAgentFixPrompt(payload, renderCtx, planInlineFromPayload(payload));

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
    const prompt = renderAgentFixPrompt(payload, renderCtx, planInlineFromPayload(payload));

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
    hasDescriptionAgentBlock: false,
  };

  it("renders fix prompt text mentioning submitReview without redaction", () => {
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
        cachedDiffForFiles([
          { file: "src/x.ts", lines: [4] },
          { file: "src/y.ts", lines: [2] },
        ]),
      ),
    });

    expect(body).toContain(REVIEW_POINTER_NOTE_LEAD);
    expect(body).toContain("[!NOTE]");
    expect(body).toContain("Call submitReview after fixing.");
    expect(body).toContain("Fix src/y.ts line 2.");
    expect(body).not.toContain("[redacted internal details]");
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
      placements: planInlineFromPayload(payload, cachedDiffForLines("src/x.ts", [4])),
    });

    expect(truncated).toBe(false);
    expect(body).toMatchSnapshot();
    expect(body).toContain(REVIEW_POINTER_NOTE_LEAD);
    expect(body).toContain("[!NOTE]");
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
      placements: planInlineFromPayload(payload),
    });

    expect(body).toContain(REVIEW_POINTER_NOTE_LEAD);
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
      placements: planInlineFromPayload(payload),
    });

    expect(body).toContain(
      "[View the updated review.](https://github.com/acme/widgets/pull/42#issuecomment-123)",
    );
    expect(body).not.toContain(REVIEW_POINTER_NOTE_LEAD);
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
      placements: planInlineFromPayload(payload),
    });

    expect(truncated).toBe(true);
    expect(body).toContain(renderReviewPointerLensMarker("review"));
    expect(body).toContain("...[truncated; see inline threads and PR summary]");
  });

  it("appends the lens marker after truncation", () => {
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
    const { body } = renderReviewPointerBody(payload, {
      ...renderCtx,
      mode: "review-security",
      placements: planInlineFromPayload(payload),
    });

    expect(body.endsWith(renderReviewPointerLensMarker("review-security"))).toBe(true);
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
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}, [see the updated review](${url}).`);
  });

  it("falls back to plain pointer when URL is missing (general)", () => {
    const body = renderRepeatNoBugsReviewBody("review");
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}. ${REVIEW_POINTER_BODY}`);
  });

  it("falls back to plain pointer when URL is missing (security)", () => {
    const body = renderRepeatNoBugsReviewBody("review-security");
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}. ${REVIEW_POINTER_BODY}`);
  });

  it("links to summary when URL is verified (quality)", () => {
    const body = renderRepeatNoBugsReviewBody("review-quality", url);
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}, [see the updated review](${url}).`);
  });

  it("falls back to plain pointer when URL is missing (quality)", () => {
    const body = renderRepeatNoBugsReviewBody("review-quality");
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}. ${REVIEW_POINTER_BODY}`);
  });

  it("links to summary when URL is verified (tests)", () => {
    const body = renderRepeatNoBugsReviewBody("review-tests", url);
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}, [see the updated review](${url}).`);
  });

  it("falls back to plain pointer when URL is missing (tests)", () => {
    const body = renderRepeatNoBugsReviewBody("review-tests");
    expect(body).toBe(`${REPEAT_NO_BUGS_PREFIX}. ${REVIEW_POINTER_BODY}`);
  });
});

describe("renderLightweightReviewCompletion", () => {
  const lightweightFooter = {
    headSha: "abc123def456",
    durationMs: 12_000,
    model: "grok-4.5",
  };

  it("preserves sentinel, alert, and table structure", () => {
    const body = renderLightweightReviewCompletion("review", lightweightFooter);
    expect(body).toContain("## PR Agent Review");
    expect(body).toContain("[!NOTE]");
    expect(body).toContain("<table>");
    expect(body).not.toContain("| | |");
    expect(body).not.toContain("—");
    expect(body).toContain("Use /review for a full review.");
    expect(body).toContain("<sub>abc123d ⋅ general ⋅ 12s ⋅ grok-4.5</sub>");
  });

  it("uses the general sentinel and footer for recognized legacy modes", () => {
    const body = renderLightweightReviewCompletion("review-security", lightweightFooter);
    expect(body).toContain(REVIEW_SUMMARY_SENTINEL);
    expect(body).toContain("<sub>abc123d ⋅ general ⋅ 12s ⋅ grok-4.5</sub>");
  });
});

describe("review hardening render helpers", () => {
  it("embeds stale review metadata in summary comment", () => {
    const body = renderReviewSummaryComment(basePayload(), {
      ...ctx,
      mode: "review",
      staleReview: true,
      placements: testPlacementsFromPayload(basePayload()),
    });
    expect(body).toContain(
      renderStaleReviewMetadataComment({
        headSha: ctx.headSha,
        mode: "review",
        stale: true,
      }),
    );
  });

  it("sanitizes invalid headSha in stale review metadata", () => {
    expect(
      renderStaleReviewMetadataComment({
        headSha: "not-a-sha -->",
        mode: "review",
        stale: false,
      }),
    ).toBe("<!-- pr-agent:review-meta headSha=invalid lens=review stale=false -->");
  });

  it("escapes double hyphens in stale review metadata attrs", () => {
    const comment = renderStaleReviewMetadataComment({
      headSha: "abc1234",
      mode: "review-security",
      stale: true,
    });
    expect(comment).toBe(
      "<!-- pr-agent:review-meta headSha=abc1234 lens=review-security stale=true -->",
    );
    expect(comment.slice(4, -3)).not.toContain("--");
  });

  it("escapes finding titles in dropped inline anchor note", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "<script>alert(1)</script>",
          detail: "detail",
          fixPrompt: "fix",
        },
      ],
    });
    const placements = testPlacementsFromPayload(payload);
    const { body } = renderReviewPointerBody(payload, {
      ...ctx,
      mode: "review",
      placements,
      droppedInlinePlacements: placements,
    });
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
  });

  it("includes dropped inline anchor note on review pointer body", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug",
          detail: "detail",
          fixPrompt: "fix",
        },
      ],
    });
    const placements = testPlacementsFromPayload(payload);
    const { body } = renderReviewPointerBody(payload, {
      ...ctx,
      mode: "review",
      placements,
      droppedInlinePlacements: placements,
    });
    expect(body).toContain("Inline anchors skipped");
    expect(body).toContain("src/a.ts");
  });
});
