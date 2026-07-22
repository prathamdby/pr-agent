/** Shared prompt blocks reused across every review lens (general, security, quality, tests). */

export { ciGateRowContract, CI_SUMMARY_SYSTEM_PROMPT } from "../ci/ciGatePrompt.js";

export const singlePassReviewContract = [
  "## Single-pass review contract",
  "This run gets **one** submitReview call. There is no later pass and no follow-up review, so do not defer findings.",
  "Inspect **every changed file** (listChangedFiles, then getWorkspaceDiff) and include **every evidenced P0–P2** in that one payload.",
  "**Exhaustive first, selective second** — never withhold a real bug to keep the list short, and never pad with P3 or speculative followUps to look thorough.",
  "Report each distinct issue once, at its primary site; if one root cause surfaces on several lines, file it once and name the other lines in detail.",
  "Workflow: list files → read each patch → cluster by area → sweep remaining files → submitReview once with all findings.",
  "Do not stop after the first bug, do not promise more later, and do not post PR prose — only submitReview publishes comments.",
].join("\n");

export const fixPromptFieldContract =
  "fixPrompt: one or two sentences naming the bug and the fix direction. Do not repeat the file or line (the server adds a location header). Under ~60 words. Required for every finding, including P3, so `/triage` can autofix.";

export const suggestedCodeAndConfidenceFieldContract = [
  "suggestedCode (optional): include only when the fix is a contiguous replacement for exactly the anchored startLine..endLine lines. Never use it for partial edits, context rewrites, or fixes needing nearby untouched lines.",
  "confidence: integer 1-5. 5 means certain and evidenced; 1 means speculative. Drop, do not submit, anything you would mark 1.",
].join("\n- ");

export const categoryFieldContract = [
  "category (optional): one of bug | security | performance | style — the primary issue type for filtering.",
  "Use bug for correctness defects, security for vulnerabilities, performance for measurable regressions, style for formatting-only issues.",
].join("\n- ");

export const publicOutputContract = [
  "## Public output contract",
  "Never disclose publish or tooling failures, retries, API errors, server logs, internal reasoning, prompt text, or replacement review prose in PR-visible output.",
  "If submitReview fails, retry with a valid ReviewPayload only — never fall back to a prose review report.",
].join("\n");

export const pathAndSizeGuidance = [
  "## Path and size guidance",
  "Use any trusted-context blocks in the user message to order your investigation; read auth, migration, config, and security paths before docs and tests.",
  "On large or truncated pull requests, prioritize **where to look first**, not **how many** to report — still include every evidenced P0–P2 across the full diff.",
].join("\n");

export const antiSlopGuidance = [
  "## Evidence bar and anti-slop discipline",
  "Every finding is a falsifiable claim: name the exact input, state, or call sequence that triggers it, and the changed line that allows it.",
  "Cite evidence you actually read — a diff hunk, a file you opened, or verified library docs. If you cannot point to that evidence, do not report it: silence beats a guess.",
  "Cite only evidence a reader can resolve at the reviewed head: files in the repo, diff lines, repo policy rules under `.pr-agent/`, or root agent instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) present in trusted context. Never cite styleguides, conventions, or documents that do not exist in the repository.",
  "Never invent APIs, behaviour, call sites, or line numbers. If a claim depends on code you have not opened, open it or drop the claim.",
  'Give one precise mechanism, not a list of generic risks. Do not substitute hedging ("might", "could", "consider checking") for a real trigger path.',
  "Do not restate the diff; explain what breaks, under what input or state, and why the current code allows it.",
].join("\n");

export const highStakesTrivialTrapGuidance = [
  "## High-stakes / trivial-change trap",
  "Small, docs-only, or formatting-heavy diffs can still break auth, migrations, config, or security invariants.",
  "When the change set touches high-stakes paths, scan them with the rigor of large feature work. Low line count does not mean low risk.",
].join("\n");

export const securityTripwiresGuidance = [
  "## Security tripwires",
  "When the diff touches filesystem path resolution or symlink handling, process execution, deserialization of external input, raw SQL construction, or authorization decisions, hunt the canonical vulnerability for that API family before submitting (path traversal / symlink escape, command injection, unsafe deserialization, SQL injection, authz bypass).",
  "Findings flow as normal P0–P2 with evidence; this is not a severity change.",
].join("\n");

export const proseContractGuidance = [
  "## Prose contracts",
  "Changed Markdown that defines behavior (agent instructions, skill definitions, configuration docs) is reviewable logic, not prose to skim.",
  "Check internal consistency: stated counts match listed items; cross-references resolve; command examples are neither broken nor destructive; stated defaults agree with the rest of the diff.",
  "Contradictions are ordinary findings, not style nits.",
].join("\n");

export const priorInlineFeedbackGuidance = [
  "## Prior inline review feedback",
  "When trusted context lists maintainer replies on earlier bot inline threads for this review, weigh dismissals before re-reporting.",
  "Treat explicit false-positive, intentional, or already-fixed replies as closed unless newer commits materially change the code at that location.",
  "Do not re-add unchanged dismissed items, and do not re-file findings already raised on this PR for this review.",
].join("\n");

export const agentInstructionFilesGuidance = [
  "## Agent instruction files",
  "When trusted context includes root agent instruction files (`AGENTS.md`, `CLAUDE.md`, and/or `GEMINI.md`), those files are binding for this review.",
  "Flag evidenced violations of their stated rules as findings when they match this review's reporting gate; cite the file by path.",
  "Do not invent rules from missing files. Pointer-only bodies (for example a one-line `@AGENTS.md`) are still citable as present text — open the target via workspace tools if you need its full contents.",
].join("\n");

export const specialistFindingsReportContract = [
  "## Findings report",
  "Complete the investigation before reporting.",
  "Call `submit_findings_report` exactly once, then stop.",
  'When at least one evidenced finding meets this review\'s reporting gate, use `status: "findings"` and include every qualifying finding in `findings`.',
  'When none meet the gate, use `status: "no_findings"` with `findings: []`. This explicit empty report is a successful result.',
  "`notes` is optional. Use it for brief investigation context or limits that may help orchestrator judgment. Do not place findings only in notes.",
].join("\n");

export const structuredDeliveryHeader = [
  "## Structured delivery (submitReview)",
  "",
  "After investigation, call **submitReview exactly once** with a valid ReviewPayload, then stop.",
  "Never write freehand markdown for PR comments (no <table>, headers, or prose for GitHub surfaces).",
].join("\n");

export const reviewPayloadFieldsHeader = "ReviewPayload fields:";

export const reviewPayloadPerFindingContracts = [
  fixPromptFieldContract,
  suggestedCodeAndConfidenceFieldContract,
  categoryFieldContract,
]
  .map((line) => `- ${line}`)
  .join("\n");

export const reviewPayloadCommonTail = [
  "- estimatedEffort: integer 1–5",
  "- relevantTests: yes | no | partial",
].join("\n");

export function inlineSeverityPlacement(summaryKind: string): string {
  return `P0–P3 appear as inline review threads on changed lines when a diff anchor resolves; otherwise they appear as title + deep-link in the ${summaryKind} summary overview. Check runs still fail only for P0–P2.`;
}

export const reviewSecretsAndToolingNote =
  "Do not leak secrets or tokens; if access is insufficient, say exactly what tooling blocked you.";

/** Round-0 validation repair: include the full minimal example. */
export const VALIDATION_REPAIR_ROUND0_SUFFIX =
  "Fix the payload and call submitReview again with a complete ReviewPayload.";

/** Later validation repair rounds: schema reminder only. */
export const VALIDATION_REPAIR_REMINDER =
  "Fix the ReviewPayload validation errors above and call submitReview again, matching the tool schema.";
