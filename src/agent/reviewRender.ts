import type {
  ReviewFinding,
  ReviewPayload,
  ReviewPublishContext,
  ReviewMode,
} from "./reviewSchema.js";
import { sanitizePublicReviewFields } from "./publicOutputSanitizer.js";
import type { InlinePlacement } from "./reviewLocationValidation.js";

export type RenderContext = ReviewPublishContext & {
  maxFindings: number;
};

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

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

function effortBar(n: number): string {
  const filled = "🔵".repeat(n);
  const empty = "⚪".repeat(5 - n);
  return filled + empty;
}

function severityBadge(severity: ReviewFinding["severity"]): string {
  return `**${severity}**`;
}

export const REVIEW_POINTER_BODY = "See the structured review summary in the PR conversation.";
export const SECURITY_REVIEW_POINTER_BODY =
  "See the security review summary in the PR conversation.";

export function reviewPointerBodyForMode(mode: ReviewMode): string {
  return mode === "review-security" ? SECURITY_REVIEW_POINTER_BODY : REVIEW_POINTER_BODY;
}

export function renderReviewPointerLine(mode: ReviewMode, summaryCommentUrl?: string): string {
  if (!summaryCommentUrl) return reviewPointerBodyForMode(mode);
  return mode === "review-security"
    ? `[View the updated security review.](${summaryCommentUrl})`
    : `[View the updated review.](${summaryCommentUrl})`;
}

export const REPEAT_NO_BUGS_PREFIX = "No bugs found";

export function renderRepeatNoBugsReviewBody(mode: ReviewMode, summaryCommentUrl?: string): string {
  if (summaryCommentUrl) {
    return mode === "review-security"
      ? `${REPEAT_NO_BUGS_PREFIX}, [see the updated security review](${summaryCommentUrl}).`
      : `${REPEAT_NO_BUGS_PREFIX}, [see the updated review](${summaryCommentUrl}).`;
  }
  return `${REPEAT_NO_BUGS_PREFIX}. ${reviewPointerBodyForMode(mode)}`;
}

export const AGENT_FIX_PROMPT_PREAMBLE =
  "Verify each finding against current code. Fix only still-valid issues, skip the rest with a brief reason, keep changes minimal, and validate.";

export const AGENT_FIX_PROMPT_ACCORDION_SUMMARY = "Prompt for AI agents to fix all review findings";

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/** GitHub review/comment body cap is 65,536; leave headroom for wrapper markup. */
export const REVIEW_POINTER_BODY_MAX_CHARS = 60_000;

const AGENT_FIX_PROMPT_TRUNCATION_SUFFIX = "\n...[truncated; see inline threads and PR summary]";

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function sortFindingsForAgentFixPrompt(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].toSorted((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) return byFile;
    return a.startLine - b.startLine;
  });
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

function renderAgentFixFindingBlock(
  finding: ReviewFinding,
  opts: { inlinePosted: boolean; inlineCapEligible?: boolean },
): string {
  return renderFindingFixBlock(finding, opts);
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

export function renderInlineThreadBody(finding: ReviewFinding, ctx: RenderContext): string {
  const safe = sanitizePublicReviewFields({
    title: finding.title,
    detail: finding.detail,
    fixPrompt: finding.fixPrompt,
  });
  const sanitizedFinding = {
    ...finding,
    title: safe.title ?? finding.title,
    detail: safe.detail ?? finding.detail,
    fixPrompt: safe.fixPrompt ?? finding.fixPrompt,
  };
  const lines = [
    `[${sanitizedFinding.severity}] ${sanitizedFinding.title}`,
    "",
    sanitizedFinding.detail,
    "",
    "<details>",
    "<summary>Prompt to fix</summary>",
    "",
    "```",
    renderSingleFindingAgentFixPrompt(sanitizedFinding, ctx),
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
    const safe = sanitizePublicReviewFields({
      title: f.title,
      detail: f.detail,
      fixPrompt: f.fixPrompt,
    });
    const sanitizedFinding = {
      ...f,
      title: safe.title ?? f.title,
      detail: safe.detail ?? f.detail,
      fixPrompt: safe.fixPrompt ?? f.fixPrompt,
    };
    const placement = placementByFinding.get(f);
    return renderAgentFixFindingBlock(sanitizedFinding, {
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
  const pointerLine = renderReviewPointerLine(ctx.mode, ctx.summaryCommentUrl);
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
  const safePayload = sanitizePublicReviewFields({
    prCharacter: payload.prCharacter,
    securityConcerns: payload.securityConcerns,
    followUps: payload.followUps,
  });
  const sortedPlacements = [...ctx.placements].toSorted((a, b) => {
    const bySeverity = SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity];
    if (bySeverity !== 0) return bySeverity;
    const byFile = a.finding.file.localeCompare(b.finding.file);
    if (byFile !== 0) return byFile;
    return a.finding.startLine - b.finding.startLine;
  });

  const rows: string[] = [];
  rows.push(ctx.summarySentinel);
  rows.push("");
  rows.push(escapeTableCell((safePayload.prCharacter ?? payload.prCharacter).trim()));
  rows.push("");
  rows.push("| | |");
  rows.push("| --- | --- |");
  rows.push(`| Effort | ${effortBar(payload.estimatedEffort)} (${payload.estimatedEffort}/5) |`);
  rows.push(`| Relevant tests | ${payload.relevantTests} |`);
  rows.push(
    `| Security | ${
      safePayload.securityConcerns != null
        ? escapeTableCell(safePayload.securityConcerns)
        : "No security concerns identified"
    } |`,
  );

  const followUps = safePayload.followUps ?? payload.followUps;
  if (followUps.length > 0) {
    rows.push("| Follow-ups | |");
    for (const item of followUps) {
      rows.push(`| | ${escapeTableCell(item)} |`);
    }
  }

  if (sortedPlacements.length === 0) {
    rows.push("");
    rows.push("_No findings._");
    return rows.join("\n");
  }

  rows.push("");
  rows.push("### Findings");
  rows.push("");

  for (const placement of sortedPlacements) {
    const f = placement.finding;
    const safeFinding = sanitizePublicReviewFields({
      title: f.title,
      detail: f.detail,
      fixPrompt: f.fixPrompt,
    });
    const link = blobLineUrl(ctx, f.file, f.startLine, f.endLine);
    const marker = placement.inlinePosted ? "Inline thread posted" : "Summary only";
    rows.push(`#### ${severityBadge(f.severity)} [${safeFinding.title ?? f.title}](${link})`);
    rows.push("");
    rows.push(`_${marker}_ · \`${f.file}\` · ${formatLineRange(f.startLine, f.endLine)}`);
    rows.push("");
    rows.push(safeFinding.detail ?? f.detail);
    if (safeFinding.fixPrompt && safeFinding.fixPrompt.length > 0) {
      if (placement.inlinePosted) {
        rows.push("");
        rows.push("_See inline thread for fix prompt._");
      } else {
        rows.push("");
        rows.push("<details>");
        rows.push("<summary>Prompt to fix</summary>");
        rows.push("");
        rows.push("```");
        rows.push(escapeCodeFenceBreakers(safeFinding.fixPrompt));
        rows.push("```");
        rows.push("");
        rows.push("</details>");
      }
    }
    rows.push("");
  }

  return rows.join("\n").trimEnd();
}
