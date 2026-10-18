import type { TriageScope } from "../../agentWork/types.ts";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.ts";
import { communicationGuidance } from "../shared/communication.ts";
import { formatFindingThreadInventoryLines } from "../shared/context.ts";
import { alreadyResolvedVerdictGuidance, dismissedVerdictGuidance } from "../shared/behavior.ts";
import { rejectedFindingSubmissionGuidance } from "../shared/repair.ts";
import { maintainerDecisionEvidenceGuidance } from "../shared/safety.ts";
import { nativeToolCallingGuidance } from "../shared/tools.ts";

export const triageNativeTooling = [
  "## Tools",
  nativeToolCallingGuidance,
  "Inspect with `readWorkspaceFile`, `searchWorkspace` (literal match, not regex), and `getWorkspaceDiff`.",
  "Change files with `editWorkspaceFile` or `createWorkspaceFile`, commit each fix with `commitFix`, and record the result with `submitTriage`. These are the only write paths; edits outside the files the inventory names are refused.",
].join("\n");

export const triageSystemPrompt = [
  "Triage prior PR Agent inline findings on the current pull request, P3 threads included. For each finding, confirm against the current workspace whether it still holds. Fix the valid findings you can fix safely, and record one verdict per finding. Make each commit a fix a maintainer would accept, because the server can push your commits to the pull request branch.",
  "",
  triageNativeTooling,
  "",
  "## Discipline",
  "- Read the code at a finding before deciding its verdict.",
  "- A fix is the smallest change that resolves the reported issue, in the files that finding needs. The scope is the inventory: new findings, unrelated files, and improvements beyond the report belong to a different change.",
  maintainerDecisionEvidenceGuidance,
  "",
  "## Done when",
  "- Make exactly one `commitFix` commit per fixed finding right after its edits, so commits do not mix findings. Include only that finding's edits, and confirm the returned diff matches what you intended.",
  `- Submit one verdict per inventory item in one \`submitTriage\` call after all commits. ${rejectedFindingSubmissionGuidance}`,
  "",
  "## Verdicts (exactly one per inventory item)",
  "- fixed: the finding is valid and you committed the minimal fix.",
  `${alreadyResolvedVerdictGuidance}.`,
  "- skipped: still valid but the fix is too risky or large, needs product input, or the fix budget is reached.",
  dismissedVerdictGuidance,
  "",
  communicationGuidance,
  "",
  "## Verdict text",
  "- `fixed` and `already-resolved`: write `evidence` as one sentence naming the file and line that resolve the finding. The schema allows at most 500 characters; the server posts this as the inline review thread reply.",
  "- `dismissed`: write `evidence` as one reusable rule sentence stating the authorized maintainer decision. The schema allows at most 500 characters; the server renders this as a suggested `.pr-agent` instruction.",
  "- `skipped`: write `reason` as one clause stating why you skipped the fix. The schema allows at most 300 characters; the server renders this in the summary table.",
  "",
  "Tests-focused findings may propose missing test cases. When still valid you may add test files, wire Vitest, and mock dependencies, using the test commit type. The fix budget and the commitFix file/diff limits still apply; skip with a reason when the test setup is too large for one commit.",
  "",
  "## Commit contract",
  "- Prove every subject and body line from the committed fix diff only; no ticket, review, session, or branch language.",
  "- Subject: `type: description` — no scope; lowercase imperative except names/terms; max 50 chars; no trailing period.",
  "- Types: feat, fix, refactor, docs, test, chore, style, perf. Match most changed lines; use chore only when nothing else fits.",
  "- Optional body: 1–5 `- ` bullets; capitalize each; no blank lines or trailing periods; only material details absent from the subject.",
  "- Use concrete verbs the diff proves; a specific action reads better than update, change, address, or improve.",
].join("\n");

type TriagePromptThread = Pick<
  BotFindingThread,
  | "rootCommentId"
  | "lens"
  | "path"
  | "line"
  | "severity"
  | "titleSnippet"
  | "humanReplies"
  | "authorizedReplies"
  | "untrustedReplies"
  | "threadUrl"
>;

export function buildTriageUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly maxFixesPerRun: number;
  readonly threads: readonly TriagePromptThread[];
  readonly scope?: TriageScope;
}): string {
  const lines = [
    `Target repository: ${params.owner}/${params.repo}`,
    `Pull request #: ${params.prNumber}`,
    `Head commit SHA: ${params.headSha}`,
    `Fix budget: ${params.maxFixesPerRun}`,
    "",
    params.scope === "thread"
      ? "Triage only the single finding below."
      : "Prior PR Agent findings to triage:",
  ];

  params.threads.forEach((thread, index) => {
    lines.push(...formatFindingThreadInventoryLines(thread, index));
  });

  return lines.join("\n");
}

export const TRIAGE_FINALIZE_COMMIT_THEN_SUBMIT =
  "call commitFix for each pending finding first, then call submitTriage once with a complete TriagePayload";

export const TRIAGE_SUBMIT_ONLY_NUDGE = `Your last reply was text only, and the server reads only tool calls. If you have uncommitted workspace edits, ${TRIAGE_FINALIZE_COMMIT_THEN_SUBMIT}.`;

export const TRIAGE_VALIDATION_REPAIR_HINT = `If needed, ${TRIAGE_FINALIZE_COMMIT_THEN_SUBMIT}.`;

export function renderTriageRepairPrompt(validationError: string): string {
  return [validationError, TRIAGE_VALIDATION_REPAIR_HINT].join("\n\n");
}
