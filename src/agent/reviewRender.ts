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
} from "../github/markdownFormat.js";
import {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  AGENT_FIX_PROMPT_PREAMBLE,
  AGENT_FIX_PROMPT_TRUNCATION_SUFFIX,
  LIGHTWEIGHT_REVIEW_COMPLETION_HINT,
  LIGHTWEIGHT_REVIEW_COMPLETION_LEAD,
  LIGHTWEIGHT_REVIEW_COMPLETION_REASON,
  REPEAT_NO_BUGS_PREFIX,
  REVIEW_EFFORT_WORDS,
  REVIEW_FINDING_FOOTNOTE_INLINE,
  REVIEW_FINDING_FOOTNOTE_SUMMARY,
  REVIEW_FINDINGS_NONE,
  REVIEW_OVERVIEW_ALERT,
  REVIEW_OVERVIEW_COMPACT_MAX_CHARS,
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_BODY_MAX_CHARS,
  REVIEW_POINTER_NOTE_LEAD,
  REVIEW_DROPPED_INLINE_NOTE_MAX_FINDINGS,
  REVIEW_TECHNICAL_DETAILS_ACCORDION_SUMMARY,
  REVIEW_SECURITY_DEFAULT,
  REVIEW_SUMMARY_BODY_MAX_CHARS,
  REVIEW_SUMMARY_COMPACTION_NOTE,
  REVIEW_SUMMARY_FINDINGS_OMITTED_SUFFIX,
  SECURITY_REVIEW_POINTER_BODY,
} from "../settings/index.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import { reviewFindingPlacementKey } from "./reviewDiffPlacement.js";
import type {
  ReviewFinding,
  ReviewPayload,
  ReviewPublishContext,
  ReviewMode,
} from "./reviewSchema.js";
import { reviewSummarySentinelForMode } from "./reviewSchema.js";
import type { InlinePlacement } from "./reviewDiffPlacement.js";

export {
  AGENT_FIX_PROMPT_ACCORDION_SUMMARY,
  AGENT_FIX_PROMPT_PREAMBLE,
  AGENT_FIX_PROMPT_TRUNCATION_SUFFIX,
  REPEAT_NO_BUGS_PREFIX,
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_BODY_MAX_CHARS,
  REVIEW_POINTER_NOTE_LEAD,
  SECURITY_REVIEW_POINTER_BODY,
} from "../settings/index.js";

export type RenderContext = ReviewPublishContext;

/** Prevent model-authored text from closing a surrounding markdown code fence. */
function escapeCodeFenceBreakers(text: string): string {
  return text.replace(/```/g, "\\`\\`\\`");
}

function blobLineUrl(ctx: RenderContext, file: string, startLine: number, endLine: number): string {
  const lineAnchor = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.headSha}/${file}#${lineAnchor}`;
}

export function issueCommentUrl(
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
): string {
  return `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${commentId}`;
}

export function formatEffortLabel(effort: number): string {
  const word = REVIEW_EFFORT_WORDS[effort - 1] ?? REVIEW_EFFORT_WORDS[2];
  return `${word} · \`${effort}/5\``;
}

function formatEffortLabelHtml(effort: number): string {
  const word = REVIEW_EFFORT_WORDS[effort - 1] ?? REVIEW_EFFORT_WORDS[2];
  return `${escapeTableHtml(word)} · ${renderTableCode(`${effort}/5`)}`;
}

export function reviewPointerBodyForMode(mode: ReviewMode): string {
  return mode === "review-security" ? SECURITY_REVIEW_POINTER_BODY : REVIEW_POINTER_BODY;
}

export function renderReviewPointerLine(mode: ReviewMode, summaryCommentUrl?: string): string {
  if (!summaryCommentUrl) return reviewPointerBodyForMode(mode);
  return mode === "review-security"
    ? `[View the updated security review.](${summaryCommentUrl})`
    : `[View the updated review.](${summaryCommentUrl})`;
}

export function renderRepeatNoBugsReviewBody(mode: ReviewMode, summaryCommentUrl?: string): string {
  if (summaryCommentUrl) {
    return mode === "review-security"
      ? `${REPEAT_NO_BUGS_PREFIX}, [see the updated security review](${summaryCommentUrl}).`
      : `${REPEAT_NO_BUGS_PREFIX}, [see the updated review](${summaryCommentUrl}).`;
  }
  return `${REPEAT_NO_BUGS_PREFIX}. ${reviewPointerBodyForMode(mode)}`;
}

export function renderLightweightReviewCompletion(mode: ReviewMode): string {
  const summarySentinel = reviewSummarySentinelForMode(mode);
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
  return rows.join("\n").trimEnd();
}

export function renderStaleReviewMetadataComment(params: {
  headSha: string;
  mode: ReviewMode;
  stale: boolean;
}): string {
  const headSha = sanitizeReviewMetaHeadSha(params.headSha);
  const lens = escapeHtmlCommentAttr(params.mode);
  const staleValue = params.stale ? "true" : "false";
  return `<!-- pr-agent:review-meta headSha=${headSha} lens=${lens} stale=${staleValue} -->`;
}

function sanitizeReviewMetaHeadSha(headSha: string): string {
  const normalized = headSha.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(normalized) ? normalized : "invalid";
}

function escapeHtmlCommentAttr(value: string): string {
  return value.replace(/--/g, "-&#45;");
}

export function renderDroppedInlineAnchorNote(
  droppedPlacements: readonly InlinePlacement[],
): string | null {
  if (droppedPlacements.length === 0) return null;
  const lines = droppedPlacements
    .slice(0, REVIEW_DROPPED_INLINE_NOTE_MAX_FINDINGS)
    .map(
      (placement) =>
        `- ${placement.finding.severity} \`${placement.finding.file}\` L${placement.finding.startLine}: ${escapeTablePlainCell(placement.finding.title)}`,
    );
  const omitted = droppedPlacements.length - lines.length;
  if (omitted > 0) {
    lines.push(`- …and ${omitted} more`);
  }
  return [
    "",
    "**Inline anchors skipped** (findings remain in the PR conversation summary):",
    ...lines,
  ].join("\n");
}

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function sortPlacements(placements: readonly InlinePlacement[]): InlinePlacement[] {
  return [...placements].toSorted((a, b) =>
    compareReviewFindingsBySeverityFileLine(a.finding, b.finding),
  );
}

function sortFindingsForAgentFixPrompt(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].toSorted(compareReviewFindingsBySeverityFileLine);
}

export function renderFindingFixBlock(
  finding: ReviewFinding,
  opts: { inlinePosted: boolean },
): string {
  const location = `@${finding.file} ${formatLineRange(finding.startLine, finding.endLine)}`;
  const lines: string[] = [];

  if (finding.severity === "P3") {
    lines.push(`[P3 — no inline thread] ${finding.title}`);
    lines.push(finding.detail);
    return lines.join("\n");
  }

  lines.push(`[${finding.severity}] ${location}`);
  lines.push(finding.fixPrompt ? escapeCodeFenceBreakers(finding.fixPrompt) : "");
  if (!opts.inlinePosted) {
    lines.push("[inline thread omitted — summary only]");
  }
  return lines.join("\n");
}

export function renderSingleFindingAgentFixPrompt(
  finding: ReviewFinding,
  ctx: RenderContext,
): string {
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
  parts.push(
    renderTableEm(
      placement.inlinePosted ? REVIEW_FINDING_FOOTNOTE_INLINE : REVIEW_FINDING_FOOTNOTE_SUMMARY,
    ),
  );
  return parts.join("<br>");
}

export function renderInlineThreadBody(finding: ReviewFinding, ctx: RenderContext): string {
  const lines = [
    `**${finding.severity}** · **${finding.title}**`,
    "",
    `\`${finding.file}\` · ${formatLineRange(finding.startLine, finding.endLine)}`,
    "",
    finding.detail,
    "",
    "<details>",
    "<summary>Prompt to fix</summary>",
    "",
    "```",
    renderSingleFindingAgentFixPrompt(finding, ctx),
    "```",
    "",
    "</details>",
  ];
  if (finding.technicalDetails != null && finding.technicalDetails.trim().length > 0) {
    lines.push(
      "",
      "<details>",
      `<summary>${REVIEW_TECHNICAL_DETAILS_ACCORDION_SUMMARY}</summary>`,
      "",
      escapeCodeFenceBreakers(finding.technicalDetails.trim()),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

export function renderAgentFixPrompt(
  payload: ReviewPayload,
  ctx: RenderContext,
  placements: readonly InlinePlacement[],
): string {
  const placementByKey = new Map(
    placements.map((placement) => [reviewFindingPlacementKey(placement.finding), placement]),
  );
  const sorted = sortFindingsForAgentFixPrompt(payload.findings);

  const blocks = sorted.map((f) => {
    const placement = placementByKey.get(reviewFindingPlacementKey(f));
    return renderFindingFixBlock(f, {
      inlinePosted: placement?.inlinePosted ?? false,
    });
  });

  return [
    AGENT_FIX_PROMPT_PREAMBLE,
    "",
    `Repository: ${ctx.owner}/${ctx.repo}`,
    `Pull request: #${ctx.prNumber}`,
    `Head SHA: ${ctx.headSha}`,
    "",
    "Findings:",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

function renderPointerLead(mode: ReviewMode, summaryCommentUrl?: string): string {
  if (summaryCommentUrl) {
    return renderReviewPointerLine(mode, summaryCommentUrl);
  }
  return renderGitHubAlert(REVIEW_OVERVIEW_ALERT, REVIEW_POINTER_NOTE_LEAD);
}

function assembleReviewPointerBody(
  pointerLine: string,
  agentFixPrompt: string,
  droppedNote: string | null,
): string {
  const parts = [
    pointerLine,
    "",
    "<details>",
    `<summary>${AGENT_FIX_PROMPT_ACCORDION_SUMMARY}</summary>`,
    "",
    "```",
    agentFixPrompt,
    "```",
    "",
    "</details>",
  ];
  if (droppedNote) {
    parts.push(droppedNote);
  }
  return parts.join("\n");
}

function truncateAgentFixPromptForPointerBody(
  agentFixPrompt: string,
  pointerLine: string,
  droppedNote: string | null,
  maxBodyChars: number,
): {
  prompt: string;
  truncated: boolean;
} {
  const wrapperOverhead = assembleReviewPointerBody(pointerLine, "", droppedNote).length;
  const maxPromptChars = Math.max(0, maxBodyChars - wrapperOverhead);

  if (agentFixPrompt.length <= maxPromptChars) {
    return { prompt: agentFixPrompt, truncated: false };
  }

  const suffixBudget = AGENT_FIX_PROMPT_TRUNCATION_SUFFIX.length;
  const cutAt = Math.max(0, maxPromptChars - suffixBudget);
  return {
    prompt: agentFixPrompt.slice(0, cutAt) + AGENT_FIX_PROMPT_TRUNCATION_SUFFIX,
    truncated: true,
  };
}

export function renderReviewPointerBody(
  payload: ReviewPayload,
  ctx: RenderContext & {
    mode: ReviewMode;
    summaryCommentUrl?: string;
    placements: readonly InlinePlacement[];
    droppedInlinePlacements?: readonly InlinePlacement[];
  },
): { body: string; truncated: boolean } {
  const pointerLine = renderPointerLead(ctx.mode, ctx.summaryCommentUrl);
  const droppedNote = renderDroppedInlineAnchorNote(ctx.droppedInlinePlacements ?? []);
  let agentFixPrompt = renderAgentFixPrompt(payload, ctx, ctx.placements);
  let truncated = false;

  let body = assembleReviewPointerBody(pointerLine, agentFixPrompt, droppedNote);
  if (body.length > REVIEW_POINTER_BODY_MAX_CHARS) {
    const result = truncateAgentFixPromptForPointerBody(
      agentFixPrompt,
      pointerLine,
      droppedNote,
      REVIEW_POINTER_BODY_MAX_CHARS,
    );
    agentFixPrompt = result.prompt;
    truncated = result.truncated;
    body = assembleReviewPointerBody(pointerLine, agentFixPrompt, droppedNote);
  }

  return { body, truncated };
}

function buildReviewSummaryBody(
  payload: ReviewPayload,
  ctx: RenderContext & {
    summarySentinel: string;
    placements: readonly InlinePlacement[];
    mode?: ReviewMode;
    staleReview?: boolean;
  },
  options: SummaryRenderOptions,
): string {
  let sortedPlacements = sortPlacements(ctx.placements);
  if (options.findingRowLimit != null) {
    sortedPlacements = sortedPlacements.slice(0, options.findingRowLimit);
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
    [renderTableStrong("Effort"), formatEffortLabelHtml(payload.estimatedEffort)],
  ];

  const summaryOnlyAccordions: string[] = [];

  if (sortedPlacements.length === 0) {
    tableRows.push([renderTableStrong("Findings"), escapeTableHtml(REVIEW_FINDINGS_NONE)]);
  } else {
    for (const placement of sortedPlacements) {
      const f = placement.finding;
      tableRows.push([
        renderTableStrong(f.severity),
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

  for (const item of payload.followUps) {
    tableRows.push([renderTableStrong("Follow-ups"), escapeTablePlainCell(item)]);
  }

  rows.push(renderKeyValueTable(tableRows));

  if (summaryOnlyAccordions.length > 0) {
    rows.push("");
    rows.push(...summaryOnlyAccordions);
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

  if (ctx.mode != null) {
    rows.push("");
    rows.push(
      renderStaleReviewMetadataComment({
        headSha: ctx.headSha,
        mode: ctx.mode,
        stale: ctx.staleReview ?? false,
      }),
    );
  }

  return rows.join("\n").trimEnd();
}

export function fitReviewSummaryBody(
  payload: ReviewPayload,
  ctx: RenderContext & {
    summarySentinel: string;
    placements: readonly InlinePlacement[];
    mode?: ReviewMode;
    staleReview?: boolean;
  },
  maxBodyChars: number,
): string {
  const sortedCount = sortPlacements(ctx.placements).length;

  const full = buildReviewSummaryBody(payload, ctx, {
    compact: false,
    includeSummaryAccordions: true,
  });
  if (full.length <= maxBodyChars) {
    return full;
  }

  const compact = buildReviewSummaryBody(payload, ctx, {
    compact: true,
    includeSummaryAccordions: false,
    compactionNote: true,
  });
  if (compact.length <= maxBodyChars) {
    return compact;
  }

  for (let limit = sortedCount - 1; limit >= 0; limit--) {
    const omitted = sortedCount - limit;
    const trimmed = buildReviewSummaryBody(payload, ctx, {
      compact: true,
      includeSummaryAccordions: false,
      compactionNote: true,
      findingRowLimit: limit,
      omittedFindingCount: omitted,
    });
    if (trimmed.length <= maxBodyChars) {
      return trimmed;
    }
  }

  return buildReviewSummaryBody(payload, ctx, {
    compact: true,
    includeSummaryAccordions: false,
    compactionNote: true,
    findingRowLimit: 0,
    omittedFindingCount: sortedCount,
  });
}

export function renderReviewSummaryComment(
  payload: ReviewPayload,
  ctx: RenderContext & {
    summarySentinel: string;
    placements: readonly InlinePlacement[];
    mode?: ReviewMode;
    staleReview?: boolean;
  },
): string {
  return fitReviewSummaryBody(payload, ctx, REVIEW_SUMMARY_BODY_MAX_CHARS);
}
