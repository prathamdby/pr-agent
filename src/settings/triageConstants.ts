/** PR triage agent block (upserted by sentinel). */
import { sanitizeGithubLogin, type ReviewCancelAttribution } from "./reviewConstants.js";

export const TRIAGE_SUMMARY_SENTINEL = "## PR Agent Triage";
export const TRIAGE_PREVIEW_SENTINEL = "## PR Agent Triage Preview";
export const TRIAGE_UNKNOWN_SUBCOMMAND =
  "Unknown `/triage` command. Use `/triage`, `/triage preview`, or `/triage all` (optional `exclude <thread ids>`).";
export const TRIAGE_INVALID_EXCLUDE =
  "`/triage all exclude` needs one or more thread root comment ids (digits, comma or space separated).";
export const TRIAGE_BULK_REQUIRES_PREVIEW =
  "`/triage all` needs a preceding `/triage preview` on this pull request head. Run `/triage preview`, read the would-be diff, then `/triage all`.";
export const TRIAGE_BULK_PREVIEW_STALE =
  "The pull request head changed since `/triage preview`. Run `/triage preview` again on the current head, then `/triage all`.";
export const TRIAGE_BULK_PARTIAL_NOTICE =
  "Partial triage: some findings applied and others did not.";
export const TRIAGE_CLOSED_PR_NOTICE =
  "Triage was cancelled because the pull request is closed or merged; no fixes were pushed.";
const TRIAGE_CANCELLED_MERGED_NOTICE = "**Triage cancelled**: PR merged. No fixes were pushed.";
const TRIAGE_CANCELLED_CLOSED_NOTICE = "**Triage cancelled**: PR closed. No fixes were pushed.";

export function triageCancelledNotice(attribution: ReviewCancelAttribution): string {
  switch (attribution.kind) {
    case "merged":
      return TRIAGE_CANCELLED_MERGED_NOTICE;
    case "closed":
      return TRIAGE_CANCELLED_CLOSED_NOTICE;
    case "user":
      return `**Triage cancelled** by @${sanitizeGithubLogin(attribution.login)}. No fixes were pushed.`;
    default: {
      const exhaustive: never = attribution;
      return exhaustive;
    }
  }
}
export const TRIAGE_ALREADY_IN_PROGRESS =
  "A `/triage` run is already queued or in progress for this pull request.";
export const TRIAGE_FAILURE_MESSAGE =
  "PR Agent could not complete the triage run after retries. Try `/triage` again later.";
export const TRIAGE_NO_ELIGIBLE_FINDINGS =
  "No triage-eligible unresolved PR Agent inline findings on this pull request.";
export const TRIAGE_THREAD_NOT_ELIGIBLE =
  "This thread is not a triage-eligible PR Agent finding (wrong thread, already resolved, or not from a bot review).";
export const TRIAGE_FULL_RUN_IN_PROGRESS =
  "A full-PR `/triage` run is already queued or in progress for this pull request.";
export const TRIAGE_INLINE_USAGE_HINT =
  "Reply with `/triage` inside a PR Agent inline finding thread, or post `/triage` on the PR conversation to triage all findings.";
export const TRIAGE_ALL_PRIOR_FINDINGS_RESOLVED =
  "All prior PR Agent inline findings on this pull request are already resolved.";
export const TRIAGE_FORK_PR_NOTICE =
  "PR Agent cannot push fixes to fork branches. Triage ran in report-only mode.";
export const TRIAGE_STALE_HEAD_NOTICE =
  "The pull request head changed while triage was running; no fixes were pushed. Re-run `/triage`.";
export const TRIAGE_THREAD_RESOLUTION_NOTICE =
  "Some fixed or already-resolved findings could not be matched to GitHub review threads, so their thread replies were skipped.";
export const TRIAGE_VALIDATION_REPAIR_ROUNDS = 3;
export const TRIAGE_PRE_SUBMIT_NUDGE_ROUNDS = 2;
export const VERIFICATION_VALIDATION_REPAIR_ROUNDS = 3;
export const VERIFICATION_PRE_SUBMIT_NUDGE_ROUNDS = 2;
/** HTML marker in the single verification stub reply owned per finding thread. */
export const VERIFICATION_STUB_MARKER = "<!-- pr-agent:verification-stub -->";
export const MAX_TRIAGE_FINDINGS = 128;
export const TRIAGE_VERDICT_EVIDENCE_MAX_CHARS = 500;
export const TRIAGE_SKIP_REASON_MAX_CHARS = 300;
export const TRIAGE_COMMIT_SUBJECT_MAX_CHARS = 50;
export const TRIAGE_COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "docs",
  "test",
  "chore",
  "style",
  "perf",
] as const;
export const TRIAGE_COMMIT_BODY_MAX_BULLETS = 5;
export const TRIAGE_COMMIT_MAX_FILES = 20;
/** Staged-diff size cap per commitFix call (added + removed lines). */
export const TRIAGE_MAX_COMMIT_DIFF_LINES = 200;
export const TRIAGE_NEW_FILE_MAX_BYTES = 32_768;

export const MAX_TOOL_ROUNDS_TRIAGE = 32;
export const MAX_TRIAGE_FIXES_PER_RUN = 10;
