import type { SpecialistBrief } from "../briefTool.js";
import type { SpecialistId, SpecialistOutcome } from "../specialistReport.js";
import type { ReviewFinding } from "../../reviewSchema.js";
import { sameFilePublishedThreadHints } from "../sameFilePublishedThreadHints.js";

/**
 * Orchestrator system prompt: recon → brief → judgment → synthesis.
 * Long prose lives here (not in settings). Specialists investigate; this session publishes.
 */
export function buildOrchestratorSystemPrompt(): string {
  return [
    "You are the review orchestrator for this pull request.",
    "You recon the change set, author one structured specialist brief, judge incoming specialist reports, publish worthy inline threads in batches, and synthesize the final review summary.",
    "You never invent findings yourself after recon — specialists investigate. You verify, dedupe, and publish.",
    "",
    "## Recon",
    "Use workspace tools (listChangedFiles, getWorkspaceDiff, read files) and Context7 when library behaviour matters.",
    "Call `submit_specialist_brief` exactly once with PR intent, architecture notes, risk areas, file map, and a focus line for each specialist (correctness, security, quality, tests).",
    "Keep focus lines concrete and scoped to this PR — not generic persona restatements.",
    "",
    "## Judgment",
    "When a specialist report arrives, verify each finding against your recon knowledge.",
    "Drop duplicates of already-published threads (same issue, adjacent lines, or same-file overlap hints from `publish_thread`).",
    "Call `publish_thread` at most once per judgment turn with the worthy remainder.",
    "Publishing zero threads is valid when nothing survives judgment — do not invent a finding to force a publish.",
    "Never disclose tooling failures, retries, or internal reasoning on the PR.",
    "",
    "## Synthesis",
    "After all specialists resolve, call `publish_summary` exactly once.",
    "Author merge verdict, overview prose, and table copy for the accepted findings.",
    "If coverage is partial (a specialist failed), say so plainly in overview fields; the server adds a coverage note.",
    "All-empty specialist reports still need a summary with no-findings prose and a COMMENT pointer review.",
  ].join("\n");
}

/** First user turn: explore the PR and submit the brief. */
export function renderReconInstruction(params: {
  prTitle: string;
  prBody: string;
  changedFilesSummary: string;
}): string {
  return [
    "Recon this pull request, then call `submit_specialist_brief` exactly once.",
    "",
    `## PR title`,
    params.prTitle.length > 0 ? params.prTitle : "(untitled)",
    "",
    `## PR body`,
    params.prBody.length > 0 ? params.prBody : "(empty)",
    "",
    `## Changed files (server index)`,
    params.changedFilesSummary.length > 0 ? params.changedFilesSummary : "(none indexed)",
    "",
    "Inspect the checkout as needed, then submit the brief.",
  ].join("\n");
}

/** Judgment turn when a specialist reports findings. */
export function renderJudgmentTurn(
  outcome: Extract<SpecialistOutcome, { kind: "report" }>,
  options?: {
    /** Server-owned findings already accepted/published this run (decision 23). */
    previouslyAcceptedFindings?: readonly ReviewFinding[];
  },
): string {
  const findingLines = outcome.report.findings.map((finding, index) =>
    formatFindingForJudgment(index + 1, finding),
  );
  const notes =
    outcome.report.notes != null && outcome.report.notes.length > 0
      ? [
          "",
          "## Specialist notes (untrusted investigation context — never publish verbatim)",
          outcome.report.notes,
        ]
      : [];

  const overlapHints = sameFilePublishedThreadHints(
    outcome.report.findings,
    options?.previouslyAcceptedFindings ?? [],
  );
  const overlapSection =
    overlapHints.length > 0
      ? [
          "",
          "## Already published / accepted on same files",
          "Compare these before you call `publish_thread` — drop paraphrased duplicates.",
          ...overlapHints.map(
            (hint) => `- \`${hint.file}\` L${hint.startLine}-L${hint.endLine}: ${hint.title}`,
          ),
        ]
      : [];

  return [
    `Specialist \`${outcome.specialist}\` reported ${outcome.report.findings.length} finding(s).`,
    "Verify each against your recon. Drop duplicates of already-published threads (same-file hints below, plus overlap hints from prior `publish_thread` results on repair).",
    "Call `publish_thread` once with the worthy remainder, or call it with an empty findings array if nothing should publish.",
    "",
    "## Findings",
    ...findingLines,
    ...notes,
    ...overlapSection,
  ].join("\n");
}

function formatFindingForJudgment(n: number, finding: ReviewFinding): string {
  return [
    `### ${n}. [${finding.severity}] ${finding.title}`,
    `- file: \`${finding.file}\` L${finding.startLine}-L${finding.endLine}`,
    `- detail: ${finding.detail}`,
    finding.fixPrompt != null ? `- fixPrompt: ${finding.fixPrompt}` : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

/** Synthesis turn after the completion pump drains. */
export function renderSynthesisTurn(params: {
  acceptedFindings: readonly ReviewFinding[];
  partialSpecialists: readonly string[];
  emptySpecialists: readonly SpecialistId[];
  brief?: SpecialistBrief | null;
}): string {
  const partialNote =
    params.partialSpecialists.length > 0
      ? `Coverage partial: ${params.partialSpecialists.join(", ")} specialist(s) failed.`
      : "Full specialist coverage.";
  const emptyNote =
    params.emptySpecialists.length > 0
      ? `Explicit no_findings from: ${params.emptySpecialists.join(", ")}.`
      : "No empty specialist reports.";
  const acceptedLines =
    params.acceptedFindings.length === 0
      ? ["(none — author no-findings overview prose)"]
      : params.acceptedFindings.map(
          (finding, index) =>
            `${index + 1}. [${finding.severity}] \`${finding.file}\` L${finding.startLine}: ${finding.title}`,
        );

  return [
    "Synthesize the final review summary and call `publish_summary` exactly once.",
    partialNote,
    emptyNote,
    "",
    "## Accepted findings (server-owned; include matching table copy)",
    ...acceptedLines,
    "",
    params.brief != null
      ? `## Recon intent reminder\n${params.brief.prIntent}`
      : "## Recon intent reminder\n(brief unavailable)",
  ].join("\n");
}
