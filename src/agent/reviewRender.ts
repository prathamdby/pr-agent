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
  REVIEW_POINTER_BODY,
  REVIEW_POINTER_BODY_MAX_CHARS,
  REVIEW_POINTER_NOTE_LEAD,
  REVIEW_SECURITY_DEFAULT,
  SECURITY_REVIEW_POINTER_BODY,
} from "../settings/index.js";
import { compareReviewFindingsBySeverityFileLine } from "./reviewFindingSort.js";
import type {
  ReviewFinding,
  ReviewPayload,
  ReviewPublishContext,
  ReviewMode,
} from "./reviewSchema.js";
import { reviewSummarySentinelForMode } from "./reviewSchema.js";
import type { InlinePlacement } from "./reviewLocationValidation.js";

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

export type RenderContext = ReviewPublishContext & {
  maxFindings: number;
};

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
  opts: { inlinePosted: boolean; inlineCapEligible?: boolean },
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
    lines.push(
      opts.inlineCapEligible === false
        ? "[inline thread omitted — severity cap]"
        : "[inline thread omitted — summary only]",
    );
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

function renderFindingTableCellHtml(
  placement: InlinePlacement,
  ctx: RenderContext,
  findingFields: FindingTableFields,
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
  if (!placement.inlinePosted) {
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
  return lines.join("\n");
}

export function renderAgentFixPrompt(
  payload: ReviewPayload,
  ctx: RenderContext,
  placements: readonly InlinePlacement[],
): string {
  const placementByFinding = new Map(placements.map((p) => [p.finding, p]));
  const sorted = sortFindingsForAgentFixPrompt(payload.findings);

  const blocks = sorted.map((f) => {
    const placement = placementByFinding.get(f);
    return renderFindingFixBlock(f, {
      inlinePosted: placement?.inlinePosted ?? false,
      inlineCapEligible: placement?.inlineCapEligible,
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

function assembleReviewPointerBody(pointerLine: string, agentFixPrompt: string): string {
  return [
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
  ].join("\n");
}

function truncateAgentFixPromptForPointerBody(
  agentFixPrompt: string,
  pointerLine: string,
  maxBodyChars: number,
): {
  prompt: string;
  truncated: boolean;
} {
  const wrapperOverhead = assembleReviewPointerBody(pointerLine, "").length;
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
  },
): { body: string; truncated: boolean } {
  const pointerLine = renderPointerLead(ctx.mode, ctx.summaryCommentUrl);
  let agentFixPrompt = renderAgentFixPrompt(payload, ctx, ctx.placements);
  let truncated = false;

  let body = assembleReviewPointerBody(pointerLine, agentFixPrompt);
  if (body.length > REVIEW_POINTER_BODY_MAX_CHARS) {
    const result = truncateAgentFixPromptForPointerBody(
      agentFixPrompt,
      pointerLine,
      REVIEW_POINTER_BODY_MAX_CHARS,
    );
    agentFixPrompt = result.prompt;
    truncated = result.truncated;
    body = assembleReviewPointerBody(pointerLine, agentFixPrompt);
  }

  return { body, truncated };
}

export function renderReviewSummaryComment(
  payload: ReviewPayload,
  ctx: RenderContext & { summarySentinel: string; placements: readonly InlinePlacement[] },
): string {
  const sortedPlacements = sortPlacements(ctx.placements);

  const rows: string[] = [];
  rows.push(ctx.summarySentinel);
  rows.push("");
  rows.push(renderGitHubAlert(REVIEW_OVERVIEW_ALERT, payload.prCharacter.trim()));
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
        renderFindingTableCellHtml(placement, ctx, {
          title: f.title,
          detail: f.detail,
          fixPrompt: f.fixPrompt,
        }),
      ]);
      if (!placement.inlinePosted && f.fixPrompt != null && f.fixPrompt.length > 0) {
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

  return rows.join("\n").trimEnd();
}
