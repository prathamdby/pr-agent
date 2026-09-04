/** Agent work (pg-boss) queue names. */
export const ACK_QUEUE = "agent-work-ack";
export const REVIEW_QUEUE = "agent-work-review";
export const ASK_QUEUE = "agent-work-ask";
export const DESCRIPTION_QUEUE = "agent-work-description";
export const TRIAGE_QUEUE = "agent-work-triage";
export const VERIFICATION_QUEUE = "agent-work-verification";
export const CI_REFRESH_QUEUE = "agent-work-ci-refresh";
export const RETENTION_QUEUE = "agent-work-retention";
export const RETENTION_QUEUE_POLLING_INTERVAL_SECONDS = 60;
/** Rows deleted per batch in the retention sweep (each batch is its own transaction). */
export const RETENTION_DELETE_BATCH_SIZE = 5_000;
export const ACK_DEAD_LETTER_QUEUE = "agent-work-ack-dead";
export const REVIEW_DEAD_LETTER_QUEUE = "agent-work-review-dead";
export const ASK_DEAD_LETTER_QUEUE = "agent-work-ask-dead";
export const DESCRIPTION_DEAD_LETTER_QUEUE = "agent-work-description-dead";
export const TRIAGE_DEAD_LETTER_QUEUE = "agent-work-triage-dead";
export const VERIFICATION_DEAD_LETTER_QUEUE = "agent-work-verification-dead";
export const CI_REFRESH_DEAD_LETTER_QUEUE = "agent-work-ci-refresh-dead";
export const DEFERRED_HEAD_SHA = "deferred-to-worker";

/** Seconds a CI-refresh waits before retrying after it hits an active review. */
export const CI_REFRESH_RETRY_DELAY_SECONDS = 15;
/**
 * Max retain hops after the original delivery. 15s × 120 = 30 minutes, enough
 * for a typical orchestrated review; exhaustion stops silently.
 */
export const CI_REFRESH_RETRY_ATTEMPT_LIMIT = 120;

/** Queues whose work types execute under a PR actor lease (see migration 023, ADR 0030). */
export const LEASED_WORK_QUEUES = [
  REVIEW_QUEUE,
  DESCRIPTION_QUEUE,
  TRIAGE_QUEUE,
  VERIFICATION_QUEUE,
] as const;

/** Queued this long with no live lease and no live pg-boss job means the delivery chain died. */
export const STALE_QUEUED_WORK_GRACE_SECONDS = 300;
export const STALE_QUEUED_WORK_BATCH_SIZE = 10;

export const IGNORED_BOT_SLASH_COMMAND = "ignored_bot_slash_command";
export const IGNORED_UNAUTHORIZED_SLASH = "ignored_unauthorized_slash";
/** Intake decision + deferred log event when a closed PR cancels active reviews. */
export const REVIEW_CANCELLED_PR_CLOSED = "review_cancelled_pr_closed";

export const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "closed"]);
export const DESCRIPTION_PUBLISH_LENS = "description" as const;
export const ASK_PUBLISH_LENS = "ask" as const;
export const TRIAGE_PUBLISH_LENS = "triage" as const;
export const VERIFICATION_PUBLISH_LENS = "verification" as const;
export const MAX_STORED_COMMENT_TEXT_LEN = 16_384;
