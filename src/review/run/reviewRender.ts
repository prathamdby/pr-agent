import {
  escapeTablePlainCell,
  escapeTableHtml,
  renderGitHubAlert,
  renderKeyValueTable,
  renderTableCode,
  renderTableEm,
  renderTableLink,
  renderTableLocationMeta,
  renderTableStrong,
} from "../../github/markdownFormat.js";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  AGENT_FIX_PROMPT_PREAMBLE,
  LIGHTWEIGHT_REVIEW_COMPLETION_HINT,
  LIGHTWEIGHT_REVIEW_COMPLETION_LEAD,
  LIGHTWEIGHT_REVIEW_COMPLETION_REASON,
  REPEAT_NO_BUGS_PREFIX,
  REVIEW_FINDING_FOOTNOTE_INLINE,
  REVIEW_FINDING_FOOTNOTE_SUMMARY,
  REVIEW_FINDING_FOOTNOTE_SUMMARY_P3,
  REVIEW_FINDINGS_NONE,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_OVERVIEW_COMPACT_MAX_CHARS,
  REVIEW_POINTER_BODY,
  REVIEW_SECURITY_DEFAULT,
  REVIEW_SUMMARY_BODY_MAX_CHARS,
  REVIEW_SUMMARY_COMPACTION_NOTE,
  REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX,
} from "../../settings/index.js";
import { compareReviewFindingsBySeverityFileLine } from "../findings/reviewFindingSort.js";
import { reviewFindingPlacementKey } from "../placement/reviewDiffPlacement.js";
import type { ReviewFinding, ReviewPayload, ReviewPublishContext } from "../reviewSchema.js";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.js";
import type { AnyReviewLens } from "../../settings/legacyReviewLenses.js";
import type { FindingSource } from "../orchestrator/orchestratorTypes.js";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.js";
import type { CachedPrDiffIndex } from "../placement/reviewDiffIndex.js";
import {
  normalizeGitHeadSha,
  renderReviewRunFooter,
  type ReviewRunFooterMeta,
} from "./reviewRunFooter.js";
import type { CiSummary } from "../ci/ciSummaryTypes.js";
import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";
import {
  formatCiSummaryPlainText,
  renderCiSummaryCell,
  shouldRenderCiSummaryRow,
} from "../ci/renderCiSummary.js";

export {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  REPEAT_NO_BUGS_PREFIX,
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_NOTE_LEAD,
} from "../../settings/index.js";

export type RenderContext = ReviewPublishContext;

const CODE_FENCE_RE = /```/g;
const HTML_COMMENT_DASH_RE = /--/g;
const HTML_COMMENT_CLOSE_RE = />/g;

/** Prevent model-authored text from closing a surrounding markdown code fence. */
function escapeCodeFenceBreakers(text: string): string {
  return text.replace(CODE_FENCE_RE, "\\`\\`\\`");
}

function blobLineUrl(ctx: RenderContext, file: string, startLine: number, endLine: number): string {
  const lineAnchor = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.headSha}/${file}#${lineAnchor}`;
}

export function renderRepeatNoBugsReviewBody(
  mode: AnyReviewLens,
  summaryCommentUrl?: string,
): string {
  if (summaryCommentUrl) {
    return `${REPEAT_NO_BUGS_PREFIX}, [see the updated review](${summaryCommentUrl}).`;
  }
  return `${REPEAT_NO_BUGS_PREFIX}. ${REVIEW_POINTER_BODY}`;
}

export function renderLightweightReviewCompletion(
  footer: { readonly headSha: string } & ReviewRunFooterMeta,
): string {
  const summarySentinel = REVIEW_SUMMARY_SENTINEL;
  const rows: string[] = [];
  rows.push(summarySentinel);
  rows.push("");
  rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, LIGHTWEIGHT_REVIEW_COMPLETION_LEAD));
  rows.push("");
  rows.push(
    renderKeyValueTable([
      [renderTableStrong("Review"), escapeTableHtml("Skipped")],
      [renderTableStrong("Reason"), escapeTablePlainCell(LIGHTWEIGHT_REVIEW_COMPLETION_REASON)],
      [renderTableStrong("Next step"), escapeTablePlainCell(LIGHTWEIGHT_REVIEW_COMPLETION_HINT)],
    ]),
  );
  rows.push("");
  rows.push(
    renderReviewRunFooter({
      headSha: footer.headSha,
      durationMs: footer.durationMs,
      model: footer.model,
    }),
  );
  return rows.join("\n").trimEnd();
}

export function renderStaleReviewMetadataComment(params: {
  headSha: string;
  mode: AnyReviewLens;
  stale: boolean;
}): string {
  const headSha = normalizeGitHeadSha(params.headSha) ?? "invalid";
  const lens = escapeHtmlCommentAttr(params.mode);
  const staleValue = params.stale ? "true" : "false";
  return `<!-- pr-agent:review-meta headSha=${headSha} lens=${lens} stale=${staleValue} -->`;
}

function escapeHtmlCommentAttr(value: string): string {
  return value.replace(HTML_COMMENT_DASH_RE, "-&#45;").replace(HTML_COMMENT_CLOSE_RE, "&gt;");
}

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function renderFindingFixBlock(finding: ReviewFinding, opts: { inlinePosted: boolean }): string {
  const location = `@${finding.file} ${formatLineRange(finding.startLine, finding.endLine)}`;
  const lines: string[] = [];

  lines.push(`[${finding.severity}] ${location}`);
  lines.push(finding.fixPrompt ? escapeCodeFenceBreakers(finding.fixPrompt) : "");
  if (!opts.inlinePosted) {
    lines.push("[inline thread omitted — summary only]");
  }
  return lines.join("\n");
}

function renderSingleFindingAgentFixPrompt(finding: ReviewFinding, ctx: RenderContext): string {
  return [
    AGENT_FIX_PROMPT_PREAMBLE,
    "",
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Pull request: #${ctx.prNumber}`,
    `Head SHA: ${ctx.headSha}`,
    "",
    renderFindingFixBlock(finding, { inlinePosted: true }),
  ].join("\n");
}

function renderSummaryOnlyFixAccordion(
  severity: ReviewFinding["severity"],
  title: string,
  fixPrompt: string,
): string[] {
  return [
    "<details>",
    `<summary>Prompt to fix — ${severity} · ${escapeTableHtml(title)}</summary>`,
    "",
    "```",
    escapeCodeFenceBreakers(fixPrompt),
    "```",
    "",
    "</details>",
  ];
}

type FindingTableFields = {
  title: string;
  detail: string;
  fixPrompt?: string;
};

type SummaryRenderOptions = {
  compact: boolean;
  includeSummaryAccordions: boolean;
  includeAgentFixAccordion: boolean;
  compactionNote?: boolean;
  findingRowLimit?: number;
  omittedFindingCount?: number;
};

function renderFindingTableCellHtml(
  placement: InlinePlacement,
  ctx: RenderContext,
  findingFields: FindingTableFields,
  compact: boolean,
): string {
  const f = placement.finding;
  const link =
    placement.inlinePosted && placement.inlineCommentUrl
      ? placement.inlineCommentUrl
      : blobLineUrl(ctx, f.file, f.startLine, f.endLine);
  const marker = placement.inlinePosted ? "On the diff" : "Summary only";
  const parts = [
    renderTableLink(findingFields.title, link),
    renderTableLocationMeta(marker, f.file, formatLineRange(f.startLine, f.endLine)),
  ];
  if (!placement.inlinePosted && !compact) {
    parts.push(escapeTablePlainCell(findingFields.detail));
  }
  const summaryFootnote =
    f.severity === "P3" ? REVIEW_FINDING_FOOTNOTE_SUMMARY_P3 : REVIEW_FINDING_FOOTNOTE_SUMMARY;
  parts.push(
    renderTableEm(placement.inlinePosted ? REVIEW_FINDING_FOOTNOTE_INLINE : summaryFootnote),
  );
  return parts.join("<br>");
}

function renderSeverityLabel(finding: ReviewFinding): string {
  if (finding.confidence == null) return finding.severity;
  return `${finding.severity} · c${finding.confidence}`;
}

function renderSuggestedCodeBlock(finding: ReviewFinding): string[] {
  if (finding.suggestedCode == null) return [];
  if (finding.startLine !== finding.endLine) return [];

  const escapedCode = escapeCodeFenceBreakers(finding.suggestedCode);
  if (escapedCode !== finding.suggestedCode) return [];

  return ["", "```suggestion", escapedCode, "```"];
}

function renderBoundPolicyFooter(boundPaths: readonly string[]): string[] {
  if (boundPaths.length === 0) return [];
  return ["", ...boundPaths.map((path) => `<sub>Bound · ${escapeTableHtml(path)}</sub>`)];
}

export function renderInlineThreadBody(
  finding: ReviewFinding,
  ctx: RenderContext,
  boundPaths: readonly string[] = [],
): string {
  const lines = [
    `**${finding.severity}** · **${finding.title}**`,
    "",
    `\`${finding.file}\` · ${formatLineRange(finding.startLine, finding.endLine)}`,
    "",
    finding.detail,
    ...renderSuggestedCodeBlock(finding),
    "",
    "<details>",
    "<summary>Prompt to fix</summary>",
    "",
    "```",
    renderSingleFindingAgentFixPrompt(finding, ctx),
    "```",
    "",
    "</details>",
    ...renderBoundPolicyFooter(boundPaths),
  ];
  return lines.join("\n");
}

export function renderAgentFixPrompt(
  payload: ReviewPayload,
  ctx: RenderContext,
  placements: readonly InlinePlacement[],
  ciSummary?: CiSummary | null,
): string {
  const placementByKey = new Map(
    placements.map((placement) => [reviewFindingPlacementKey(placement.finding), placement]),
  );
  const sorted = [...payload.findings].toSorted(compareReviewFindingsBySeverityFileLine);

  const blocks = sorted.map((f) => {
    const placement = placementByKey.get(reviewFindingPlacementKey(f));
    return renderFindingFixBlock(f, {
      inlinePosted: placement?.inlinePosted ?? false,
    });
  });

  const lines = [
    AGENT_FIX_PROMPT_PREAMBLE,
    "",
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Pull request: #${ctx.prNumber}`,
    `Head SHA: ${ctx.headSha}`,
    "",
    "Findings:",
    "",
    blocks.join("\n\n"),
  ];
  if (shouldRenderCiSummaryRow(ciSummary)) {
    lines.push(
      "",
      escapeCodeFenceBreakers(
        wrapUntrustedBlock("ci_summary", formatCiSummaryPlainText(ciSummary)),
      ),
    );
  }
  return lines.join("\n");
}

function assembleAgentFixAccordion(agentFixPrompt: string): string {
  return [
    "<details>",
    `<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`,
    "",
    "```",
    agentFixPrompt,
    "```",
    "",
    "</details>",
  ].join("\n");
}

export function renderReviewPointerLensMarker(mode: AnyReviewLens): string {
  return `<!-- pr-agent:review-pointer lens=${escapeHtmlCommentAttr(mode)} -->`;
}

/** Files-tab pull request review body for one specialist batch (Note + tagline only). */
export function renderSpecialistReviewBody(params: {
  readonly specialist: FindingSource;
  readonly progressCommentUrl: string;
  readonly lensMarker?: string;
}): string {
  const note = renderGitHubAlert(
    REVIEW_OVERVIEW_ALERT,
    `Track this run on the [progress stub](${params.progressCommentUrl}) in the PR conversation.`,
  );
  const tagline = `\`${params.specialist}\` Here's what the ${params.specialist} found.`;
  const parts = [note, "", tagline];
  if (params.lensMarker) {
    parts.push(params.lensMarker);
  }
  return parts.join("\n");
}

type ReviewSummaryRenderCtx = RenderContext & {
  summarySentinel: string;
  placements: readonly InlinePlacement[];
  mode: AnyReviewLens;
  runFooter: ReviewRunFooterMeta;
  staleReview?: boolean;
  cachedDiffIndex?: CachedPrDiffIndex;
  /** Server-derived CI gate; omitted when disabled, unavailable, or no checks. */
  ciSummary?: CiSummary | null;
  partialCoverageNote?: string;
};

/** Expects `ctx.placements` pre-sorted by severity, file, and line. */
function buildReviewSummaryBody(
  payload: ReviewPayload,
  ctx: ReviewSummaryRenderCtx,
  options: SummaryRenderOptions,
): string {
  let visiblePlacements = [...ctx.placements];
  if (options.findingRowLimit != null) {
    visiblePlacements = visiblePlacements.slice(0, options.findingRowLimit);
  }
  const overview = options.compact
    ? payload.prCharacter.trim().slice(0, REVIEW_OVERVIEW_COMPACT_MAX_CHARS)
    : payload.prCharacter.trim();

  const rows: string[] = [];
  rows.push(ctx.summarySentinel);
  rows.push("");
  rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, overview));
  rows.push("");

  const tableRows: Array<[string, string]> = [
    [renderTableStrong("Size"), renderTableCode(payload.size)],
  ];

  const summaryOnlyAccordions: string[] = [];

  if (visiblePlacements.length === 0) {
    tableRows.push([renderTableStrong("Findings"), escapeTableHtml(REVIEW_FINDINGS_NONE)]);
  } else {
    for (const placement of visiblePlacements) {
      const f = placement.finding;
      tableRows.push([
        renderTableStrong(renderSeverityLabel(f)),
        renderFindingTableCellHtml(
          placement,
          ctx,
          {
            title: f.title,
            detail: f.detail,
            fixPrompt: f.fixPrompt,
          },
          options.compact,
        ),
      ]);
      if (
        options.includeSummaryAccordions &&
        !placement.inlinePosted &&
        f.severity !== "P3" &&
        f.fixPrompt != null &&
        f.fixPrompt.length > 0
      ) {
        summaryOnlyAccordions.push(
          ...renderSummaryOnlyFixAccordion(f.severity, f.title, f.fixPrompt),
        );
      }
    }
  }

  tableRows.push([renderTableStrong("Relevant tests"), escapeTableHtml(payload.relevantTests)]);
  tableRows.push([
    renderTableStrong("Security"),
    payload.securityConcerns != null
      ? escapeTablePlainCell(payload.securityConcerns)
      : escapeTableHtml(REVIEW_SECURITY_DEFAULT),
  ]);

  if (shouldRenderCiSummaryRow(ctx.ciSummary)) {
    tableRows.push([renderTableStrong("CI"), renderCiSummaryCell(ctx.ciSummary)]);
  }

  for (const item of payload.followUps) {
    tableRows.push([renderTableStrong("Follow-ups"), escapeTablePlainCell(item)]);
  }

  rows.push(renderKeyValueTable(tableRows));

  if (ctx.partialCoverageNote) {
    rows.push("");
    rows.push(ctx.partialCoverageNote);
  }

  if (summaryOnlyAccordions.length > 0) {
    rows.push("");
    rows.push(...summaryOnlyAccordions);
  }

  if (options.includeAgentFixAccordion && ctx.placements.length > 0) {
    rows.push("");
    rows.push(
      assembleAgentFixAccordion(renderAgentFixPrompt(payload, ctx, ctx.placements, ctx.ciSummary)),
    );
  }

  if (options.compactionNote) {
    rows.push("");
    rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_SUMMARY_COMPACTION_NOTE));
  }

  if (options.omittedFindingCount != null && options.omittedFindingCount > 0) {
    rows.push("");
    rows.push(
      renderGitHubAlert(
        REVIEW_OVERVIEW_ALERT,
        `${options.omittedFindingCount} ${REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX}`,
      ),
    );
  }

  rows.push("");
  rows.push(
    renderStaleReviewMetadataComment({
      headSha: ctx.headSha,
      mode: ctx.mode,
      stale: ctx.staleReview ?? false,
    }),
  );

  if (ctx.hasDescriptionReviewMap) {
    rows.push("");
    rows.push(
      `See the [review map](https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}) in the PR description.`,
    );
  }

  rows.push("");
  rows.push(
    renderReviewRunFooter({
      headSha: ctx.headSha,
      durationMs: ctx.runFooter.durationMs,
      model: ctx.runFooter.model,
    }),
  );

  return rows.join("\n").trimEnd();
}

export function fitReviewSummaryBody(
  payload: ReviewPayload,
  ctx: ReviewSummaryRenderCtx,
  maxBodyChars: number,
): string {
  const sortedPlacements = [...ctx.placements].toSorted((a, b) =>
    compareReviewFindingsBySeverityFileLine(a.finding, b.finding),
  );
  const sortedCtx = { ...ctx, placements: sortedPlacements };
  const sortedCount = sortedPlacements.length;

  const full = buildReviewSummaryBody(payload, sortedCtx, {
    compact: false,
    includeSummaryAccordions: true,
    includeAgentFixAccordion: true,
  });
  if (full.length <= maxBodyChars) {
    return full;
  }

  const compact = buildReviewSummaryBody(payload, sortedCtx, {
    compact: true,
    includeSummaryAccordions: false,
    includeAgentFixAccordion: true,
    compactionNote: true,
  });
  if (compact.length <= maxBodyChars) {
    return compact;
  }

  let lo = 0;
  let hi = sortedCount - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const limit = Math.floor((lo + hi) / 2);
    const omitted = sortedCount - limit;
    const trimmed = buildReviewSummaryBody(payload, sortedCtx, {
      compact: true,
      includeSummaryAccordions: false,
      includeAgentFixAccordion: true,
      compactionNote: true,
      findingRowLimit: limit,
      omittedFindingCount: omitted,
    });
    if (trimmed.length <= maxBodyChars) {
      best = trimmed;
      lo = limit + 1;
    } else {
      hi = limit - 1;
    }
  }
  if (best) return best;

  return buildReviewSummaryBody(payload, sortedCtx, {
    compact: true,
    includeSummaryAccordions: false,
    includeAgentFixAccordion: false,
    compactionNote: true,
    findingRowLimit: 0,
    omittedFindingCount: sortedCount,
  });
}
export function renderReviewSummaryComment(
  payload: ReviewPayload,
  ctx: ReviewSummaryRenderCtx,
): string {
  return fitReviewSummaryBody(payload, ctx, REVIEW_SUMMARY_BODY_MAX_CHARS);
}
