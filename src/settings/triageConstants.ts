/** PR triage agent block (upserted by sentinel). */
export const TRIAGE_SUMMARY_SENTINEL = "## PR Agent Triage";
export const TRIAGE_ALREADY_IN_PROGRESS =
  "A `/triage` run is already queued or in progress for this pull request.";
export const TRIAGE_FAILURE_MESSAGE =
  "PR Agent could not complete the triage run after retries. Try `/triage` again later.";
export const TRIAGE_NO_PRIOR_FINDINGS =
  "No prior PR Agent inline findings to triage on this pull request. Run `/review` first.";

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
export const TRIAGE_COMMIT_MAX_FILES = 20;
/** Staged-diff size cap per commitFix call (added + removed lines). */
export const TRIAGE_MAX_COMMIT_DIFF_LINES = 200;
export const TRIAGE_NEW_FILE_MAX_BYTES = 32_768;
