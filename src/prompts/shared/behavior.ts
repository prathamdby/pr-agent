export const readOnlyReviewGuidance =
  "**Static analysis only.** Read the checkout and documentation. Do not run the reviewed program, execute its tests, send requests, reproduce exploits, or modify files. The review runs against untrusted code, so execution stays out of scope.";

export const outOfScopeFilesGuidance = [
  "## Out-of-scope files",
  "Findings belong on files this pull request changes. Generated and vendored trees (`dist/`, `node_modules/`, `vendor/`, `generated/`, build outputs) are not reviewed, because nobody edits them by hand.",
].join("\n");

export const SEVERITY_DEFINITIONS = [
  'P0: a demonstrated, reachable path to a consequential production failure: data loss or corruption, a security breach, a crash or outage, or money movement. The trigger is identified in code read this session, at adequate certainty. A sensitive file name, a missing test, a style or policy issue, or a "could in theory" chain is never P0.',
  "P1: a high-confidence defect with a concrete trigger and a consequence a caller, user, persisted record, security boundary, or operator can observe.",
  "P2: a plausible defect with real impact; the trigger path is plausible and the detail states what remains uncertain. P2 is the ceiling for test-gap findings.",
  "P3: a real, bounded, low-impact defect that meets the causal-publication contract.",
] as const;

export const severityRubric = [
  "## Severity",
  ...SEVERITY_DEFINITIONS.map((line) => `- ${line}`),
  "An inflated P0 or P1 burns the check's meaning and the author's trust exactly as a missed one loses a defect.",
].join("\n");

export function severityDefinitionText(): string {
  return SEVERITY_DEFINITIONS.join(" ");
}

export const causalPublicationContract = [
  "## Causal-publication contract",
  "A finding describes one atomic problem and contains all of these:",
  "- A trigger: a concrete input, state, call sequence, lifecycle transition, or concurrent interleaving.",
  "- The behaviour this pull request introduced or exposed that is wrong, harmful, or an unprotected regression (the changed behaviour, an untested state of code or a file present at the reviewed head, the invariant, and the plausible failure).",
  "- An observable consequence for a caller, user, persisted record, security boundary, runtime operation, or test contract.",
  "- Evidence from the reviewed head that you read in this session: a diff hunk, an opened file, or verified library docs. The server authorizes findings against that read evidence.",
  "- A bounded fix direction that addresses the cause rather than restating the symptom.",
  "Cite only what a reader can resolve at the reviewed head: repository files, diff lines, `.pr-agent/` rules, or root agent instruction files present in the instruction-files context. Do not name a file, path, or body the checkout does not contain. A filename a loader could accept is not evidence that the file exists. APIs, behaviour, call sites, and line numbers all come from code you read.",
  "When a claim depends on unread code, read it first. When checkout coverage is sparse or a search is truncated, the absence of callers or references is unproven.",
  "One root cause with several symptoms is one finding. Separately fixable root causes are separate findings, so split a compound candidate and keep each part that meets this contract.",
  'Lead the title and detail with the causal defect. Replace hedges such as "might" or "consider checking" with the trigger you demonstrated. In `detail`, state the trigger, proving line, broken invariant, and consequence in two or three short sentences. Do not restate the diff or quote code.',
  "Leave out candidates that do not meet the contract. Praise, diff summaries, and general warnings are not findings.",
  "Each specialist adds its own gates for correctness, security mitigations, present-harm quality, or precise test gaps on top of this floor.",
].join("\n");

export const highStakesTrivialTrapGuidance = [
  "## High-stakes / trivial-change trap",
  "Small, docs-only, or formatting-heavy diffs can still break auth, migrations, config, or security invariants.",
  "When the change set touches high-stakes paths, review them with the rigor of large feature work. Low line count does not mean low risk.",
].join("\n");

export const alreadyResolvedVerdictGuidance =
  "- already-resolved: the current code no longer has the issue";

export const dismissedVerdictGuidance =
  "- dismissed: an authorized maintainer decision clearly says false positive, intentional, will-not-fix, or rejected for this finding thread.";
