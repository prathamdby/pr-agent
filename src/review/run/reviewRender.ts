import {
  escapeCodeFence,
  escapeTablePlainCell,
  escapeTableHtml,
  renderGitHubAlert,
  renderKeyValueTable,
  renderTableCode,
  renderTableEm,
  renderTableLink,
  renderTableLocationMeta,
  renderTableStrong,
} from "../../github/markdownFormat.ts";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  AGENT_FIX_PROMPT_PREAMBLE,
  LIGHTWEIGHT_REVIEW_COMPLETION_HINT,
  LIGHTWEIGHT_REVIEW_COMPLETION_LEAD,
  LIGHTWEIGHT_REVIEW_COMPLETION_REASON,
  REVIEW_FINDING_FOOTNOTE_INLINE,
  REVIEW_FINDING_FOOTNOTE_SUMMARY,
  REVIEW_FINDING_FOOTNOTE_SUMMARY_P3,
  REVIEW_FINDINGS_NONE,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_SUMMARY_BODY_MAX_CHARS,
  REVIEW_SUMMARY_COMPACTION_NOTE,
  REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX,
  type AnyReviewLens,
} from "../../settings/index.ts";
import { compareReviewFindingsBySeverityFileLine } from "../findings/reviewFindingSort.ts";
import { reviewFindingPlacementKey } from "../placement/reviewDiffPlacement.ts";
import type { ReviewFinding, ReviewPayload, ReviewPublishContext } from "../reviewSchema.ts";
import { REVIEW_SUMMARY_SENTINEL } from "../reviewSchema.ts";
import type { FindingSource } from "../orchestrator/orchestratorTypes.ts";
import type { InlinePlacement } from "../placement/reviewDiffPlacement.ts";
import {
  renderFindingMarker,
  renderFindingRowMarker,
  type FindingId,
  type FindingRowMarker,
} from "../findingIdentity/findingMarker.ts";
import type { CachedPrDiffIndex } from "../../prWorkspace/reviewDiffIndex.ts";
import type { InventoryFinding } from "../findingIdentity/findingInventory.ts";
import {
  findingSeverityLabel,
  largestFittingBody,
  renderCarriedFindingCell,
  truncateWithEllipsis,
  renderResolvedThisRun,
  type FindingView,
  type FindingViewRow,
} from "../findingIdentity/findingLifecycle.ts";
import { FINDING_INVENTORY_UNAVAILABLE_NOTE } from "../statusCopy.ts";
import {
  normalizeGitHeadSha,
  renderReviewRunFooter,
  type ReviewRunFooterMeta,
} from "./reviewRunFooter.ts";
import type { CiSummary } from "../ci/ciFacts.ts";
import { wrapUntrustedBlock } from "../../prompts/shared/safety.ts";
import {
  formatReviewActionLineCiStatus,
  renderReviewActionLineCiStatus,
  formatCiSummaryPlainText,
  renderCiSummaryCell,
  shouldIncludeCiInAgentFixPrompt,
  shouldRenderCiSummaryRow,
} from "../ci/ciSummaryCell.ts";

export type RenderContext = ReviewPublishContext;

export type SummaryPlacement = InlinePlacement & { readonly findingRow?: FindingRowMarker };

const DURABLE_ROW_TITLE_MAX_CHARS = 80;

const HTML_COMMENT_DASH_RE = /--/g;
const HTML_COMMENT_CLOSE_RE = />/g;
const CONTROL_MARKER_OPEN_RE = /<!--(?=\s*pr-agent:)/g;

function neutralizeControlMarkers(text: string) {
  return ((pinnedReturn: string) => pinnedReturn)(text.replace(CONTROL_MARKER_OPEN_RE, "&lt;!--"));
}

function blobLineUrl(ctx: RenderContext, file: string, startLine: number, endLine: number) {
  const lineAnchor = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return ((pinnedReturn: string) => pinnedReturn)(
    `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.headSha}/${file}#${lineAnchor}`,
  );
}

export function renderLightweightReviewCompletion(
  footer: { readonly headSha: string } & ReviewRunFooterMeta,
  options?: {
    readonly ciSummary?: CiSummary | null;
    readonly ciVersion?: number;
    readonly findingsSection?: string;
  },
) {
  const summarySentinel = REVIEW_SUMMARY_SENTINEL;
  const tableRows: Array<[string, string]> = [
    [renderTableStrong("Review"), escapeTableHtml("Skipped")],
    [renderTableStrong("Reason"), escapeTablePlainCell(LIGHTWEIGHT_REVIEW_COMPLETION_REASON)],
    [renderTableStrong("Next step"), escapeTablePlainCell(LIGHTWEIGHT_REVIEW_COMPLETION_HINT)],
  ];
  if (shouldRenderCiSummaryRow(options?.ciSummary)) {
    tableRows.push([
      renderTableStrong("CI"),
      renderCiSummaryCell(options?.ciSummary, footer.headSha, options?.ciVersion),
    ]);
  }
  const rows: string[] = [];
  rows.push(summarySentinel);
  rows.push("");
  rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, LIGHTWEIGHT_REVIEW_COMPLETION_LEAD));
  rows.push("");
  rows.push(renderKeyValueTable(tableRows));
  rows.push("");
  if (options?.findingsSection != null && options.findingsSection.length > 0) {
    rows.push(options.findingsSection);
    rows.push("");
  }
  rows.push(
    renderStaleReviewMetadataComment({
      headSha: footer.headSha,
      mode: "review",
      stale: false,
    }),
  );
  rows.push(
    renderReviewRunFooter({
      headSha: footer.headSha,
      durationMs: footer.durationMs,
      model: footer.model,
    }),
  );
  return ((pinnedReturn: string) => pinnedReturn)(rows.join("\n").trimEnd());
}

export function renderStaleReviewMetadataComment(params: {
  headSha: string;
  mode: AnyReviewLens;
  stale: boolean;
}) {
  const headSha = normalizeGitHeadSha(params.headSha) ?? "invalid";
  const lens = escapeHtmlCommentAttr(params.mode);
  const staleValue = params.stale ? "true" : "false";
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:review-meta headSha=${headSha} lens=${lens} stale=${staleValue} -->`,
  );
}

function escapeHtmlCommentAttr(value: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    value.replace(HTML_COMMENT_DASH_RE, "-&#45;").replace(HTML_COMMENT_CLOSE_RE, "&gt;"),
  );
}

function formatLineRange(startLine: number, endLine: number) {
  return ((pinnedReturn: string) => pinnedReturn)(
    startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`,
  );
}

function renderFindingFixBlock(finding: ReviewFinding, opts: { inlinePosted: boolean }) {
  const location = `@${finding.file} ${formatLineRange(finding.startLine, finding.endLine)}`;
  const lines: string[] = [];

  lines.push(`[${finding.severity}] ${location}`);
  lines.push(finding.fixPrompt ? escapeCodeFence(finding.fixPrompt) : "");
  if (!opts.inlinePosted) {
    lines.push("[inline thread omitted — summary only]");
  }
  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}

function renderSingleFindingAgentFixPrompt(finding: ReviewFinding, ctx: RenderContext) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      AGENT_FIX_PROMPT_PREAMBLE,
      "",
      `Repository: ${ctx.owner}/${ctx.repo}`,
      `Pull request: #${ctx.prNumber}`,
      `Head SHA: ${ctx.headSha}`,
      "",
      renderFindingFixBlock(finding, { inlinePosted: true }),
    ].join("\n"),
  );
}

function renderSummaryOnlyFixAccordion(
  severity: ReviewFinding["severity"],
  title: string,
  fixPrompt: string,
) {
  return ((pinnedReturn: string[]) => pinnedReturn)([
    "<details>",
    `<summary>Prompt to fix — ${severity} · ${escapeTableHtml(title)}</summary>`,
    "",
    "```",
    escapeCodeFence(fixPrompt),
    "```",
    "",
    "</details>",
  ]);
}

type FindingTableFields = {
  title: string;
  detail: string;
  fixPrompt?: string;
};

type SummaryRenderOptions = {
  compact: boolean;
  minimalDurableRows?: boolean;
  includeSummaryAccordions: boolean;
  includeAgentFixAccordion: boolean;
  compactionNote?: boolean;
  findingRowLimit?: number;
  durableRowLimit?: number;
  omittedFindingCount?: number;
};

function truncatedTitle(title: string) {
  return truncateWithEllipsis(title, DURABLE_ROW_TITLE_MAX_CHARS);
}

function renderMinimalDurableRowCellHtml(
  placement: SummaryPlacement,
  row: FindingRowMarker,
  ctx: RenderContext,
) {
  const f = placement.finding;
  return ((pinnedReturn: string) => pinnedReturn)(
    `${renderTableLink(
      truncatedTitle(f.title),
      blobLineUrl(ctx, f.file, f.startLine, f.endLine),
    )}<br>${renderTableLocationMeta("Summary only", f.file, formatLineRange(f.startLine, f.endLine))}${renderFindingRowMarker(row)}`,
  );
}

function renderFindingTableCellHtml(
  placement: SummaryPlacement,
  ctx: RenderContext,
  findingFields: FindingTableFields,
  compact: boolean,
) {
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
  const rowMarker = placement.findingRow ? renderFindingRowMarker(placement.findingRow) : "";
  return ((pinnedReturn: string) => pinnedReturn)(`${parts.join("<br>")}${rowMarker}`);
}

function renderSeverityLabel(finding: ReviewFinding) {
  if (finding.confidence == null) return ((pinnedReturn: string) => pinnedReturn)(finding.severity);
  return ((pinnedReturn: string) => pinnedReturn)(`${finding.severity} · c${finding.confidence}`);
}

function renderSuggestedCodeBlock(finding: ReviewFinding) {
  if (finding.suggestedCode == null) return ((pinnedReturn: string[]) => pinnedReturn)([]);
  if (finding.startLine !== finding.endLine) return ((pinnedReturn: string[]) => pinnedReturn)([]);

  const escapedCode = neutralizeControlMarkers(escapeCodeFence(finding.suggestedCode));
  if (escapedCode !== finding.suggestedCode) return ((pinnedReturn: string[]) => pinnedReturn)([]);

  return ((pinnedReturn: string[]) => pinnedReturn)(["", "```suggestion", escapedCode, "```"]);
}

function renderBoundPolicyFooter(boundPaths: readonly string[]) {
  if (boundPaths.length === 0) return ((pinnedReturn: string[]) => pinnedReturn)([]);
  return ((pinnedReturn: string[]) => pinnedReturn)([
    "",
    ...boundPaths.map((path) => `<sub>Bound · ${escapeTableHtml(path)}</sub>`),
  ]);
}

export function renderInlineThreadBody(
  finding: ReviewFinding,
  ctx: RenderContext,
  identity: {
    readonly id: FindingId;
    readonly lens: FindingSource;
    readonly reopens?: FindingId;
    readonly relatedLinks?: readonly string[];
  },
  boundPaths: readonly string[] = [],
) {
  const relatedLinks = identity.relatedLinks ?? [];
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
    ...(relatedLinks.length > 0
      ? ["", `Possibly related: ${relatedLinks.map((url) => `[thread](${url})`).join(", ")}`]
      : []),
  ];
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      neutralizeControlMarkers(lines.join("\n")),
      "",
      renderFindingMarker({
        id: identity.id,
        lens: identity.lens,
        severity: finding.severity,
        ...(identity.reopens != null ? { reopens: identity.reopens } : {}),
      }),
    ].join("\n"),
  );
}

export function renderAgentFixPrompt(
  payload: ReviewPayload,
  ctx: RenderContext,
  placements: readonly InlinePlacement[],
  ciSummary?: CiSummary | null,
) {
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
  if (payload.followUps.length > 0) {
    lines.push(
      "",
      "Follow-ups:",
      "",
      payload.followUps.map((item, index) => `${index + 1}. ${escapeCodeFence(item)}`).join("\n"),
    );
  }
  if (shouldIncludeCiInAgentFixPrompt(ciSummary)) {
    lines.push(
      "",
      escapeCodeFence(wrapUntrustedBlock("ci_summary", formatCiSummaryPlainText(ciSummary))),
    );
  }
  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}

function assembleAgentFixAccordion(agentFixPrompt: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      "<details>",
      `<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`,
      "",
      "```",
      agentFixPrompt,
      "```",
      "",
      "</details>",
    ].join("\n"),
  );
}

export function renderReviewPointerLensMarker(mode: AnyReviewLens) {
  return ((pinnedReturn: string) => pinnedReturn)(
    `<!-- pr-agent:review-pointer lens=${escapeHtmlCommentAttr(mode)} -->`,
  );
}

export function renderSpecialistReviewBody(params: {
  readonly specialist: FindingSource;
  readonly progressCommentUrl: string;
  readonly lensMarker?: string;
}) {
  const note = renderGitHubAlert(
    REVIEW_OVERVIEW_ALERT,
    `Track this run on the [progress stub](${params.progressCommentUrl}) in the PR conversation.`,
  );
  const tagline = `\`${params.specialist}\` Here's what the ${params.specialist} found.`;
  const parts = [note, "", tagline];
  if (params.lensMarker) {
    parts.push(params.lensMarker);
  }
  return ((pinnedReturn: string) => pinnedReturn)(parts.join("\n"));
}

export type ReviewActionLineCoverage = {
  readonly kind: "full" | "partial" | "none";
  readonly failed: readonly string[];
  readonly unread?: boolean;
  readonly unjudged?: readonly string[];
};

type ReviewSummaryRenderCtx = RenderContext & {
  summarySentinel: string;
  placements: readonly SummaryPlacement[];
  findingView: FindingView;
  mode: AnyReviewLens;
  runFooter: ReviewRunFooterMeta;
  staleReview?: boolean;
  cachedDiffIndex?: CachedPrDiffIndex;
  ciSummary?: CiSummary | null;
  ciVersion?: number;
  coverage?: ReviewActionLineCoverage;
  policyAlert?: string;
};

type CarriedSummaryRow = readonly [FindingViewRow, InventoryFinding];

function carriedSummaryRows(view: FindingView) {
  return ((pinnedReturn: CarriedSummaryRow[]) => pinnedReturn)(
    view.rows.flatMap((row) =>
      ((pinnedReturn: CarriedSummaryRow[]) => pinnedReturn)(
        row.observedThisRun || row.held == null ? [] : [[row, row.held]],
      ),
    ),
  );
}

function isDurableCarriedRow([, held]: CarriedSummaryRow) {
  return ((pinnedReturn: boolean) => pinnedReturn)(held.source === "summary");
}

export function formatReviewCoverageStatus(coverage: ReviewActionLineCoverage) {
  const failed = coverage.failed.length > 0;
  const names = failed ? formatFailedSpecialistNames(coverage.failed) : "";
  const unjudged = coverage.unjudged ?? [];
  const unjudgedText =
    unjudged.length > 0 ? `not judged: ${formatFailedSpecialistNames(unjudged)}` : "";
  if (unjudgedText.length > 0 && !failed && coverage.unread !== true && coverage.kind !== "none") {
    return ((pinnedReturn: string) => pinnedReturn)(unjudgedText);
  }
  let base = "with full coverage";
  if (coverage.unread && failed && coverage.kind === "partial") {
    base = `except ${names}, with unread files`;
  } else if (coverage.unread) {
    base = "with unread files";
  } else if (coverage.kind !== "full" && failed && coverage.kind === "none") {
    base = `with no coverage (${names} failed)`;
  } else if (coverage.kind !== "full" && failed) {
    base = `except ${names}`;
  }
  return ((pinnedReturn: string) => pinnedReturn)(
    unjudgedText.length > 0 ? `${base}, ${unjudgedText}` : base,
  );
}

export { formatReviewActionLineCiStatus };

export function renderReviewActionLine(input: {
  openCount: number;
  blockingCount: number;
  followUpCount: number;
  ciStatusText: string;
  coverageStatusText: string;
  suppressReadyToMerge?: boolean;
  unjudged?: boolean;
}) {
  const followUpSegment =
    input.openCount > 0 && input.followUpCount > 0
      ? ` ${formatFollowUpCountClause(input.followUpCount)}.`
      : "";
  const findingClause =
    input.unjudged === true && input.openCount === 0
      ? "Review not fully judged"
      : input.suppressReadyToMerge && input.openCount === 0
        ? "No findings"
        : formatFindingCountClause(input.openCount, input.blockingCount);
  return ((pinnedReturn: string) => pinnedReturn)(
    `${findingClause}.${followUpSegment} ${input.ciStatusText}. All specialists ran ${input.coverageStatusText}.`,
  );
}

function formatFindingCountClause(openCount: number, blockingCount: number) {
  if (openCount === 0)
    return ((pinnedReturn: string) => pinnedReturn)("No findings, ready to merge");
  if (blockingCount === 0) {
    return ((pinnedReturn: string) => pinnedReturn)(
      openCount === 1
        ? "1 open finding, none blocks merge"
        : `${openCount} open findings, none block merge`,
    );
  }
  if (blockingCount >= openCount) {
    return ((pinnedReturn: string) => pinnedReturn)(
      openCount === 1 ? "1 finding blocks merge" : `${openCount} findings block merge`,
    );
  }
  return ((pinnedReturn: string) => pinnedReturn)(
    `${blockingCount} of ${openCount} open findings block merge`,
  );
}

function formatFollowUpCountClause(count: number) {
  return ((pinnedReturn: string) => pinnedReturn)(
    count === 1 ? "1 follow-up" : `${count} follow-ups`,
  );
}

export function renderFollowUpsCell(items: readonly string[]) {
  return ((pinnedReturn: string) => pinnedReturn)(
    items.map((item, index) => `${index + 1}. ${escapeTablePlainCell(item)}`).join("<br>"),
  );
}

function formatFailedSpecialistNames(failed: readonly string[]) {
  if (failed.length === 0) return ((pinnedReturn: string) => pinnedReturn)("");
  if (failed.length === 1) return ((pinnedReturn: string) => pinnedReturn)(failed[0] ?? "");
  if (failed.length === 2)
    return ((pinnedReturn: string) => pinnedReturn)(`${failed[0]} and ${failed[1]}`);
  return ((pinnedReturn: string) => pinnedReturn)(
    `${failed.slice(0, -1).join(", ")}, and ${failed[failed.length - 1]}`,
  );
}

function buildReviewSummaryBody(
  payload: ReviewPayload,
  ctx: ReviewSummaryRenderCtx,
  options: SummaryRenderOptions,
) {
  const carriedRows = carriedSummaryRows(ctx.findingView);
  let droppableRowsLeft = options.findingRowLimit ?? Number.POSITIVE_INFINITY;
  let durableRowsLeft = options.durableRowLimit ?? Number.POSITIVE_INFINITY;
  const keepRow = (durable: boolean) => {
    if (durable) {
      durableRowsLeft -= 1;
      return ((pinnedReturn: boolean) => pinnedReturn)(durableRowsLeft >= 0);
    }
    droppableRowsLeft -= 1;
    return ((pinnedReturn: boolean) => pinnedReturn)(droppableRowsLeft >= 0);
  };
  const visiblePlacements = ctx.placements.filter((placement) =>
    keepRow(placement.findingRow != null),
  );
  const visibleCarriedRows = carriedRows.filter((row) => keepRow(isDurableCarriedRow(row)));
  const visibleRowCount = visiblePlacements.length + visibleCarriedRows.length;
  const omittedFindingNote =
    options.omittedFindingCount != null && options.omittedFindingCount > 0
      ? `${options.omittedFindingCount} ${REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX}`
      : null;
  const coverage = ctx.coverage ?? { kind: "full", failed: [] };
  const unjudgedLenses = coverage.unjudged ?? [];
  const actionLine = renderReviewActionLine({
    openCount: ctx.placements.length + carriedRows.length,
    blockingCount: ctx.findingView.blockingCount,
    ciStatusText: renderReviewActionLineCiStatus(ctx.ciSummary),
    coverageStatusText: formatReviewCoverageStatus(coverage),
    followUpCount: payload.followUps.length,
    suppressReadyToMerge: coverage.unread === true,
    unjudged: unjudgedLenses.length > 0,
  });

  const rows: string[] = [];
  rows.push(ctx.summarySentinel);
  rows.push("");
  rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, actionLine));
  rows.push("");
  if (unjudgedLenses.length > 0) {
    rows.push(`Judgment did not finish for ${formatFailedSpecialistNames(unjudgedLenses)}.`);
    rows.push("");
  }
  if (ctx.policyAlert) {
    rows.push(renderGitHubAlert("WARNING", ctx.policyAlert));
    rows.push("");
  }

  const tableRows: Array<[string, string]> = [
    [renderTableStrong("Size"), renderTableCode(payload.size)],
  ];

  const summaryOnlyAccordions: string[] = [];

  if (visibleRowCount === 0) {
    tableRows.push([
      renderTableStrong("Findings"),
      escapeTableHtml(omittedFindingNote ?? REVIEW_FINDINGS_NONE),
    ]);
  } else {
    for (const placement of visiblePlacements) {
      const f = placement.finding;
      tableRows.push([
        renderTableStrong(renderSeverityLabel(f)),
        options.minimalDurableRows && placement.findingRow
          ? renderMinimalDurableRowCellHtml(placement, placement.findingRow, ctx)
          : renderFindingTableCellHtml(
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
    for (const [row, held] of visibleCarriedRows) {
      tableRows.push([
        renderTableStrong(findingSeverityLabel(row.severity)),
        renderCarriedFindingCell(row, held),
      ]);
    }
  }

  if (shouldRenderCiSummaryRow(ctx.ciSummary)) {
    tableRows.push([
      renderTableStrong("CI"),
      renderCiSummaryCell(ctx.ciSummary, ctx.headSha, ctx.ciVersion),
    ]);
  }

  tableRows.push([renderTableStrong("Mergeability"), escapeTablePlainCell(payload.mergeability)]);
  tableRows.push([renderTableStrong("Blast Radius"), escapeTablePlainCell(payload.blastRadius)]);

  if (payload.followUps.length > 0) {
    tableRows.push([renderTableStrong("Follow-ups"), renderFollowUpsCell(payload.followUps)]);
  }

  rows.push(renderKeyValueTable(tableRows));

  const resolvedThisRun = renderResolvedThisRun(ctx.findingView);
  if (resolvedThisRun.length > 0) {
    rows.push("");
    rows.push(resolvedThisRun);
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

  if (ctx.findingView.completeness !== "complete") {
    rows.push("");
    rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, FINDING_INVENTORY_UNAVAILABLE_NOTE));
  }

  if (options.compactionNote) {
    rows.push("");
    rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_SUMMARY_COMPACTION_NOTE));
  }

  if (omittedFindingNote != null && visibleRowCount > 0) {
    rows.push("");
    rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, omittedFindingNote));
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

  return ((pinnedReturn: string) => pinnedReturn)(rows.join("\n").trimEnd());
}

export function fitReviewSummaryBody(
  payload: ReviewPayload,
  ctx: ReviewSummaryRenderCtx,
  maxBodyChars: number,
) {
  const sortedPlacements = [...ctx.placements].toSorted((a, b) =>
    compareReviewFindingsBySeverityFileLine(a.finding, b.finding),
  );
  const sortedCtx = { ...ctx, placements: sortedPlacements };
  const carriedRows = carriedSummaryRows(ctx.findingView);
  const droppableCount =
    sortedPlacements.filter((placement) => placement.findingRow == null).length +
    carriedRows.filter((row) => !isDurableCarriedRow(row)).length;
  const durableCount = sortedPlacements.length + carriedRows.length - droppableCount;

  const full = buildReviewSummaryBody(payload, sortedCtx, {
    compact: false,
    includeSummaryAccordions: true,
    includeAgentFixAccordion: true,
  });
  if (full.length <= maxBodyChars) {
    return ((pinnedReturn: string) => pinnedReturn)(full);
  }

  const compact = buildReviewSummaryBody(payload, sortedCtx, {
    compact: true,
    includeSummaryAccordions: false,
    includeAgentFixAccordion: true,
    compactionNote: true,
  });
  if (compact.length <= maxBodyChars) {
    return ((pinnedReturn: string) => pinnedReturn)(compact);
  }

  const trimmed = largestFittingBody(droppableCount - 1, maxBodyChars, (limit) =>
    buildReviewSummaryBody(payload, sortedCtx, {
      compact: true,
      includeSummaryAccordions: false,
      includeAgentFixAccordion: true,
      compactionNote: true,
      findingRowLimit: limit,
      omittedFindingCount: droppableCount - limit,
    }),
  );
  if (trimmed) return ((pinnedReturn: string) => pinnedReturn)(trimmed);

  const minimal = (findingRowLimit: number, durableRowLimit: number) =>
    buildReviewSummaryBody(payload, sortedCtx, {
      compact: true,
      minimalDurableRows: true,
      includeSummaryAccordions: false,
      includeAgentFixAccordion: false,
      compactionNote: true,
      findingRowLimit,
      durableRowLimit,
      omittedFindingCount: droppableCount - findingRowLimit + durableCount - durableRowLimit,
    });
  return ((pinnedReturn: string) => pinnedReturn)(
    largestFittingBody(droppableCount, maxBodyChars, (limit) => minimal(limit, durableCount)) ??
      largestFittingBody(durableCount - 1, maxBodyChars, (limit) => minimal(0, limit)) ??
      minimal(0, 0),
  );
}

export function renderReviewSummaryComment(payload: ReviewPayload, ctx: ReviewSummaryRenderCtx) {
  return ((pinnedReturn: string) => pinnedReturn)(
    fitReviewSummaryBody(payload, ctx, REVIEW_SUMMARY_BODY_MAX_CHARS),
  );
}
