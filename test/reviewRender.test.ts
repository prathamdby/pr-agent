import { describe, expect, it } from "vitest";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  REPEAT_NO_BUGS_PREFIX,
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_NOTE_LEAD,
  renderAgentFixPrompt,
  renderInlineThreadBody,
  renderLightweightReviewCompletion,
  renderRepeatNoBugsReviewBody,
  renderReviewPointerLensMarker,
  renderReviewSummaryComment,
  renderSpecialistReviewBody,
  renderStaleReviewMetadataComment,
  fitReviewSummaryBody,
} from "../src/review/run/reviewRender.js";
import {
  REVIEW_FINDING_FOOTNOTE_INLINE,
  REVIEW_FINDING_FOOTNOTE_SUMMARY_P3,
  REVIEW_FINDINGS_NONE,
  REVIEW_SUMMARY_BODY_MAX_CHARS,
  REVIEW_SUMMARY_COMPACTION_NOTE,
  REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX,
} from "../src/settings/index.js";
import type { ReviewPayload } from "../src/review/reviewSchema.js";
import { makeReviewPayload } from "./helpers/reviewPayloadFactory.js";
import { REVIEW_SUMMARY_SENTINEL } from "../src/review/reviewSchema.js";
import { planInlinePlacements } from "../src/review/placement/reviewDiffPlacement.js";
import { cachedDiffForFiles, testPlacements } from "./helpers/reviewPublishTestHelpers.js";

const ctx = {
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: "abc123def456",
  hasDescriptionReviewMap: false,
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
      placements: testPlacements(basePayload().findings),
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
    const fixAll = body.indexOf(`<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`);
    expect(fixAll).toBeGreaterThan(-1);
    expect(body.indexOf("❌ CI failing — lint", fixAll)).toBeGreaterThan(fixAll);
    expect(body.indexOf("src/foo.ts:12 — Unexpected any", fixAll)).toBeGreaterThan(fixAll);
  });

  it("shows the CI gate row when Checks permission is missing", () => {
    const body = renderReviewSummaryComment(basePayload(), {
      ...ctx,
      placements: testPlacements(basePayload().findings),
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
    expect(body).toContain(REVIEW_FINDING_FOOTNOTE_SUMMARY_P3);
    expect(body).not.toContain("<summary>Prompt to fix</summary>");
    expect(body).not.toContain("<summary>Prompt to fix — P3 · Typo in heading</summary>");
    expect(body).toContain(`<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`);
    expect(body).toContain("Fix the typo in the README heading.");
  });

  it("keeps summary-only P3 out of personal Prompt to fix accordions", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P3",
          file: "src/nits.ts",
          startLine: 3,
          endLine: 3,
          title: "Rename local",
          detail: "cosmetic",
          fixPrompt: "Rename the local in src/nits.ts.",
        },
        {
          severity: "P3",
          file: "src/nits.ts",
          startLine: 8,
          endLine: 8,
          title: "Drop dead import",
          detail: "unused",
          fixPrompt: "Remove the unused import in src/nits.ts.",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings, { inlinePosted: false }),
    });
    expect(body).not.toContain("<summary>Prompt to fix — P3 ·");
    expect(body).toContain(REVIEW_FINDING_FOOTNOTE_SUMMARY_P3);
    expect(body).toContain(`<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`);
    expect(body).toContain("Rename the local in src/nits.ts.");
    expect(body).toContain("Remove the unused import in src/nits.ts.");
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

  it("appends aggregate Fix All accordion after the findings table covering all specialists", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P0",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Null deref",
          detail: "Missing guard.",
          fixPrompt: "Guard null in src/a.ts.",
        },
        {
          severity: "P1",
          file: "src/b.ts",
          startLine: 2,
          endLine: 2,
          title: "Auth bypass",
          detail: "Missing check.",
          fixPrompt: "Add auth check in src/b.ts.",
        },
      ],
    });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings),
    });
    const tableClose = body.indexOf("</table>");
    const fixAll = body.indexOf(`<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`);
    expect(tableClose).toBeGreaterThan(-1);
    expect(fixAll).toBeGreaterThan(tableClose);
    expect(body).toContain("Guard null in src/a.ts.");
    expect(body).toContain("Add auth check in src/b.ts.");
    expect(body).not.toContain(REVIEW_POINTER_BODY);
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
      placements: testPlacements(payload.findings),
    });
    expect(body).toContain("Webhook secret compared");
  });

  it("escapes pipes in prCharacter", () => {
    const payload = basePayload({ prCharacter: "Adds auth | breaks table" });
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings),
    });
    expect(body).toContain("[!NOTE]");
    expect(body).toContain("Adds auth | breaks table");
  });

  it("uses the general summary identity for recognized legacy modes", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      mode: "review-security",
      placements: testPlacements(payload.findings),
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
      placements: testPlacements(payload.findings),
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
      placements: testPlacements(payload.findings, { inlinePosted: false }),
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
        placements: testPlacements(payload.findings, { inlinePosted: false }),
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
      placements: testPlacements(payload.findings),
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

  it("appends review map link when hasDescriptionReviewMap is true", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      hasDescriptionReviewMap: true,
      placements: testPlacements(payload.findings),
    });
    expect(body).toContain(
      "See the [review map](https://github.com/acme/widgets/pull/42) in the PR description.",
    );
  });

  it("omits review map link when hasDescriptionReviewMap is false", () => {
    const payload = basePayload();
    const body = renderReviewSummaryComment(payload, {
      ...ctx,
      placements: testPlacements(payload.findings),
    });
    expect(body).not.toContain("review map");
    expect(body).not.toContain("file walkthrough");
  });
});

const inlineCtx = {
  owner: "acme",
  repo: "widgets",
  prNumber: 42,
  headSha: "abc123def456",
  hasDescriptionReviewMap: false,
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

  it("appends a subscript rule footer after Prompt to fix when violatedRule is set", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P2",
        file: "src/review/foo.ts",
        startLine: 10,
        endLine: 12,
        title: "Cross-layer import",
        detail: "Worker imports a web-only module.",
        fixPrompt: "Move the shared helper into a neutral module.",
        violatedRule: ".pr-agent/web-worker-boundary.mdc",
      },
      inlineCtx,
    );

    expect(body).toContain("</details>\n\n<sub>Rule · .pr-agent/web-worker-boundary.mdc</sub>");
    expect(body.endsWith("<sub>Rule · .pr-agent/web-worker-boundary.mdc</sub>")).toBe(true);
  });

  it("omits the rule footer when violatedRule is absent", () => {
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

    expect(body).not.toContain("<sub>Rule");
  });

  it("HTML-escapes violatedRule in the subscript footer", () => {
    const body = renderInlineThreadBody(
      {
        severity: "P3",
        file: "src/b.ts",
        startLine: 1,
        endLine: 1,
        title: "Style",
        detail: "Formatting.",
        fixPrompt: "Reformat.",
        violatedRule: ".pr-agent/evil<script>.mdc",
      },
      inlineCtx,
    );

    expect(body).toContain("<sub>Rule · .pr-agent/evil&lt;script&gt;.mdc</sub>");
    expect(body).not.toContain("<sub>Rule · .pr-agent/evil<script>.mdc</sub>");
  });
});

describe("renderAgentFixPrompt", () => {
  const renderCtx = {
    owner: "acme",
    repo: "widgets",
    prNumber: 42,
    headSha: "abc123def456",
    hasDescriptionReviewMap: false,
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
      planInlinePlacements(
        payload.findings,
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
      planInlinePlacements(payload.findings, diffIndex),
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
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlinePlacements(payload.findings, undefined),
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
      planInlinePlacements(payload.findings, undefined),
    );

    expect(prompt).toContain("[inline thread omitted — summary only]");
    expect(prompt).not.toContain("[inline thread omitted — severity cap]");
  });

  it("appends CI summary plain text after findings", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug",
          detail: "d",
          fixPrompt: "Fix src/a.ts line 1.",
        },
      ],
    });
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlinePlacements(payload.findings, undefined),
      {
        status: "failing",
        headline: "❌ CI failing — lint",
        failures: [
          {
            name: "lint",
            reason: "src/foo.ts:12 — Unexpected any",
            fixHint: "Fix the reported lint/format findings locally, then re-push.",
          },
        ],
      },
    );

    expect(prompt).toContain("Fix src/a.ts line 1.");
    expect(prompt.indexOf("Findings:")).toBeLessThan(prompt.indexOf("❌ CI failing — lint"));
    expect(prompt).toContain("src/foo.ts:12 — Unexpected any");
    expect(prompt).toContain("Fix the reported lint/format findings locally, then re-push.");
    expect(prompt.endsWith("then re-push.")).toBe(true);
  });

  it("omits CI text when summary status is none", () => {
    const payload = basePayload({
      findings: [
        {
          severity: "P1",
          file: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "Bug",
          detail: "d",
          fixPrompt: "Fix src/a.ts line 1.",
        },
      ],
    });
    const prompt = renderAgentFixPrompt(
      payload,
      renderCtx,
      planInlinePlacements(payload.findings, undefined),
      { status: "none", headline: "No CI checks on this head", failures: [] },
    );
    expect(prompt).not.toContain("No CI checks on this head");
  });
});

describe("renderSpecialistReviewBody", () => {
  const progressCommentUrl = "https://github.com/acme/widgets/pull/42#issuecomment-99";

  it("renders NOTE then specialist tagline with progress stub link and no Fix All", () => {
    const body = renderSpecialistReviewBody({
      specialist: "security",
      progressCommentUrl,
    });

    expect(body).toContain("[!NOTE]");
    expect(body).toContain(
      `Track this run on the [progress stub](${progressCommentUrl}) in the PR conversation.`,
    );
    expect(body).toContain("Here's what the security found.");
    expect(body.indexOf("[!NOTE]")).toBeLessThan(body.indexOf("Here's what the security found."));
    expect(body).not.toContain(REVIEW_POINTER_BODY);
    expect(body).not.toContain(REVIEW_POINTER_NOTE_LEAD);
    expect(body).not.toContain("<details>");
    expect(body).not.toContain(AGENT_FIX_PROMPT_ACCORDION_SUMMARY);
  });

  it("swaps the specialist id in the tagline", () => {
    expect(
      renderSpecialistReviewBody({
        specialist: "correctness",
        progressCommentUrl,
      }),
    ).toContain("Here's what the correctness found.");
    expect(
      renderSpecialistReviewBody({
        specialist: "quality",
        progressCommentUrl,
      }),
    ).toContain("Here's what the quality found.");
    expect(
      renderSpecialistReviewBody({
        specialist: "tests",
        progressCommentUrl,
      }),
    ).toContain("Here's what the tests found.");
  });

  it("appends the review pointer lens marker for triage recognition", () => {
    const body = renderSpecialistReviewBody({
      specialist: "security",
      progressCommentUrl,
      lensMarker: renderReviewPointerLensMarker("review"),
    });
    expect(body.endsWith(renderReviewPointerLensMarker("review"))).toBe(true);
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
    const body = renderLightweightReviewCompletion(lightweightFooter);
    expect(body).toContain("## PR Agent Review");
    expect(body).toContain("[!NOTE]");
    expect(body).toContain("<table>");
    expect(body).not.toContain("| | |");
    expect(body).not.toContain("—");
    expect(body).toContain("Use /review for a full review.");
    expect(body).toContain("<sub>abc123d ⋅ general ⋅ 12s ⋅ grok-4.5</sub>");
    expect(body).toContain(REVIEW_SUMMARY_SENTINEL);
  });
});

describe("review hardening render helpers", () => {
  it("embeds stale review metadata in summary comment", () => {
    const body = renderReviewSummaryComment(basePayload(), {
      ...ctx,
      mode: "review",
      staleReview: true,
      placements: testPlacements(basePayload().findings),
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
});
