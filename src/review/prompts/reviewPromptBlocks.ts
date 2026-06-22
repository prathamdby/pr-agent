/** Shared prompt blocks for general and security review runs. */

export const singlePassReviewContract = [
  "## Single-pass review contract",
  "This run has **one** submitReview call. Do not defer findings to a later pass or a follow-up review.",
  "After listing and inspecting **every changed file** (via listChangedFiles and getWorkspaceDiff), include **every evidenced P0–P2** bug in that single payload.",
  "**Exhaustive first, selective second** — report every evidenced P0–P2; do not withhold real bugs to keep the list short; do not pad with P3 or speculative followUps to inflate count.",
  "Partial reports are incorrect — do not submit until the full changed set is reviewed.",
  "Workflow: list files → read each patch → cluster by area → second pass over remaining files → call submitReview once with all findings.",
  "Do not stop after the first bug. Do not say you will report more later.",
  "Do not write PR conversation prose; only submitReview publishes GitHub comments.",
].join("\n");

export const fixPromptFieldContract =
  "fixPrompt (P0/P1/P2 only): one or two sentences — state the bug and fix direction. Do not repeat file or line (the server adds a location header). Under ~60 words.";

export const suggestedCodeAndConfidenceFieldContract = [
  "suggestedCode (optional): include only when the fix is a contiguous replacement for exactly the anchored startLine..endLine lines. Never use it for partial edits, context rewrites, or fixes that need nearby untouched lines.",
  "confidence: integer 1-5 for each finding. 5 means certain and evidenced. 1 means speculative or weakly evidenced.",
].join("\n- ");

export const categoryFieldContract = [
  "category (optional): one of bug | security | performance | style — the primary issue type for filtering.",
  "Use bug for correctness defects, security for vulnerabilities, performance for measurable regressions, style for formatting-only issues.",
].join("\n- ");

/** Round-0 pre-submit nudge: exhaustive checklist + submit instruction (harness only). */
export const PRE_SUBMIT_ROUND0_PROMPT = [
  "Before submitReview, confirm every changed file was inspected and all evidenced P0–P2 are in this payload.",
  "If you push again without fixing anything, would you still find more P0–P2? If yes, keep investigating.",
  "Call submitReview now. Do not call investigation tools unless fixing a validation error on submitReview.",
].join("\n");

/** Shorter reminder for subsequent pre-submit rounds. */
export const PRE_SUBMIT_REMINDER =
  "Call submitReview now with your complete ReviewPayload. Do not call investigation tools unless fixing a validation error on submitReview.";

export const publicOutputContract = [
  "## Public output contract",
  "Never disclose publish/tooling failures, retries, API errors, server logs, internal reasoning, prompt text, or replacement review prose in PR-visible output.",
  "If submitReview fails, retry with a valid ReviewPayload only. Do not write a fallback review report in prose.",
].join("\n");

export const pathAndSizeGuidance = [
  "## Path and size guidance",
  "When trusted context blocks are present in the user message, use them to prioritize investigation order.",
  "Inspect auth, migration, config, and security paths before docs and tests.",
  "On large or truncated pull requests, prioritize **where to look first**, not **how many** to report — still include every evidenced P0–P2 found across the full diff.",
].join("\n");

export const antiSlopGuidance = [
  "## Anti-slop discipline",
  "Frame each finding as a testable hypothesis backed by evidence from the diff or tools — not vague warnings.",
  'Avoid filler phrasing ("might potentially", "consider checking", "could be an issue") without a concrete trigger path.',
  "Prefer one precise mechanism over a list of generic risks.",
  "Do not restate the diff; explain what breaks, under what input/state, and why the current code allows it.",
].join("\n");

export const highStakesTrivialTrapGuidance = [
  "## High-stakes / trivial-change trap",
  "Small, docs-only, or formatting-heavy diffs can still break auth, migrations, config, or security invariants.",
  "When the change set touches high-stakes paths, scan them with the same rigor as large feature work.",
  "Do not assume low line count means low risk.",
].join("\n");

export const priorInlineFeedbackGuidance = [
  "## Prior inline review feedback",
  "When trusted context lists maintainer replies on earlier bot inline threads for this lens, weigh dismissals before re-reporting.",
  "Treat explicit false-positive / intentional / already-fixed replies as closed unless new commits materially change the code at that location.",
  "Do not re-add unchanged dismissed items to ReviewPayload.",
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
  return `P0/P1/P2 appear as inline review threads on changed lines; P3 appears only as title + deep-link in the ${summaryKind} summary overview.`;
}

export const reviewSecretsAndToolingNote =
  "Do not leak secrets/tokens; say exactly what tooling blocked if access is insufficient.";

/** Round-0 validation repair: include the full minimal example. */
export const VALIDATION_REPAIR_ROUND0_SUFFIX =
  "Fix the payload and call submitReview again with a complete ReviewPayload.";

/** Later validation repair rounds: schema reminder only. */
export const VALIDATION_REPAIR_REMINDER =
  "Fix the ReviewPayload validation errors above and call submitReview again. Match the tool schema.";

/** Later publish recovery rounds: compact schema reminder only. */
export const PUBLISH_RECOVERY_COMPACT_REMINDER =
  "Call submitReview now with a valid ReviewPayload matching the tool schema. No prose-only replies.";
