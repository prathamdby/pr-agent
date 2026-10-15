import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import { communicationGuidance } from "../shared/communication.js";
import { formatFindingThreadInventoryLines } from "../shared/context.js";
import { alreadyResolvedVerdictGuidance, dismissedVerdictGuidance } from "../shared/behavior.js";
import { rejectedFindingSubmissionGuidance } from "../shared/repair.js";
import { maintainerDecisionEvidenceGuidance } from "../shared/safety.js";
import {
  GUEST_CAPABILITY_SPECS,
  type GuestCapabilitySpec,
} from "../../agent/codemode/guestCatalogue.js";
import { renderCodeModeHarness } from "../shared/tools.js";

const VERIFICATION_GUEST_NAMES: ReadonlySet<string> = new Set([
  "readWorkspaceFile",
  "searchWorkspace",
  "getWorkspaceDiff",
]);

export const VERIFICATION_GUEST_SPECS: readonly GuestCapabilitySpec[] =
  GUEST_CAPABILITY_SPECS.filter((spec) => VERIFICATION_GUEST_NAMES.has(spec.name));

export const verificationInvestigationHarness = renderCodeModeHarness({
  guest: VERIFICATION_GUEST_SPECS,
  nativeTools: ["execute", "submitVerification"],
  cellBoundary: "Submitting happens outside the cell: after inspection, call `submitVerification`.",
  extra: [
    "This profile has no `listChangedFiles`, `findFiles`, `getWorkspaceBlame`, `resolveSymbol`, or Context7; the inventory names the paths to inspect.",
  ],
});

export const verificationSystemPrompt = [
  "Verification run: re-check prior PR Agent inline findings against the new pull request head, and record whether each one still holds.",
  "This run is read-only and limited to the inventory: it has no write tools, and new findings belong to the next review.",
  "",
  verificationInvestigationHarness,
  "",
  "## Discipline",
  "- Compare the finding's original concern against the current code at the new head.",
  maintainerDecisionEvidenceGuidance,
  "",
  "## Done when",
  "- You have read the current code at each finding's location through `execute({ code })` and compared it with the finding's concern.",
  `- Every inventory item has one verdict, submitted in one \`submitVerification\` call. ${rejectedFindingSubmissionGuidance}`,
  "",
  "## Verdicts (exactly one per inventory item)",
  "- fixed: the push's commits resolved the issue. Cite the user's commit sha that fixed it.",
  `${alreadyResolvedVerdictGuidance}, but no single commit in this push clearly addressed it.`,
  "- skipped: the issue is still present. Include a brief reason.",
  dismissedVerdictGuidance,
  "- Each evidence or reason is one sentence that cites the file and line it rests on, without restating the finding.",
  "",
  communicationGuidance,
].join("\n");

type PushedCommit = {
  readonly sha: string;
  readonly subject: string;
};

type VerificationPromptThread = Pick<
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

export function buildVerificationUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly pushedCommits: readonly PushedCommit[];
  readonly threads: readonly VerificationPromptThread[];
  readonly compareFilesTruncated?: boolean;
}): string {
  const lines = [
    `Target repository: ${params.owner}/${params.repo}`,
    `Pull request #: ${params.prNumber}`,
    `Head commit SHA: ${params.headSha}`,
  ];

  if (params.pushedCommits.length > 0) {
    lines.push("", "Pushed commits in this update:");
    for (const commit of params.pushedCommits) {
      lines.push(`- ${commit.sha} ${commit.subject}`);
    }
  }

  if (params.compareFilesTruncated) {
    lines.push(
      "",
      "Note: the push compare file list is truncated (GitHub returns at most 300 files).",
      "Treat changed-file membership as incomplete; do not assume omitted paths were untouched.",
    );
  }

  lines.push("", "Prior PR Agent findings to verify:");

  params.threads.forEach((thread, index) => {
    lines.push(...formatFindingThreadInventoryLines(thread, index));
  });

  return lines.join("\n");
}

export const VERIFICATION_SUBMIT_ONLY_NUDGE =
  "Your last reply was text only, and the server reads only the submitVerification call. Call submitVerification now with a complete VerificationPayload.";

export function renderVerificationRepairPrompt(validationError: string): string {
  return [validationError, "Fix the payload and call submitVerification again."].join("\n\n");
}
