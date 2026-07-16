/** Agent work (pg-boss) queue names. */
export const ACK_QUEUE = "agent-work-ack";
export const REVIEW_QUEUE = "agent-work-review";
export const ASK_QUEUE = "agent-work-ask";
export const DESCRIPTION_QUEUE = "agent-work-description";
export const TRIAGE_QUEUE = "agent-work-triage";
export const VERIFICATION_QUEUE = "agent-work-verification";
export const THREAD_REPLY_CLASSIFY_QUEUE = "agent-work-thread-classify";
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
export const THREAD_REPLY_CLASSIFY_DEAD_LETTER_QUEUE = "agent-work-thread-classify-dead";
export const DEFERRED_HEAD_SHA = "deferred-to-worker";

/** webhook_events.processing_decision values for async thread-reply classification. */
export const THREAD_REPLY_CLASSIFICATION_QUEUED = "thread_reply_classification_queued";
export const THREAD_REPLY_ASK_ENQUEUED = "thread_reply_ask_enqueued";
export const THREAD_REPLY_CLASSIFICATION_FAILED = "thread_reply_classification_failed";
export const IGNORED_NON_BOT_THREAD_REPLY = "ignored_non_bot_thread_reply";
export const IGNORED_BOT_SLASH_COMMAND = "ignored_bot_slash_command";
export const IGNORED_UNAUTHORIZED_SLASH = "ignored_unauthorized_slash";

export const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
export const AUTOMATED_REVIEW_LENS = "review" as const;
export const DESCRIPTION_PUBLISH_LENS = "description" as const;
export const ASK_PUBLISH_LENS = "ask" as const;
export const TRIAGE_PUBLISH_LENS = "triage" as const;
export const VERIFICATION_PUBLISH_LENS = "verification" as const;
export const MAX_STORED_COMMENT_TEXT_LEN = 16_384;
