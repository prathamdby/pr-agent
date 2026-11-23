export const REVIEW_QUEUE = "agent-work-review";
export const ASK_QUEUE = "agent-work-ask";
export const DESCRIPTION_QUEUE = "agent-work-description";
export const TRIAGE_QUEUE = "agent-work-triage";
export const VERIFICATION_QUEUE = "agent-work-verification";
export const RETENTION_DELETE_BATCH_SIZE = 5_000;
export const DEFERRED_HEAD_SHA = "deferred-to-worker";

export const ESCALATED_TOOL_ROUNDS_MULTIPLIER = 2;
export const ESCALATED_TOOL_ROUNDS_CAP = 4_000;

export const IGNORED_BOT_SLASH_COMMAND = "ignored_bot_slash_command";
export const IGNORED_UNAUTHORIZED_SLASH = "ignored_unauthorized_slash";
export const REVIEW_APPROVED = "review_approved";
export const IGNORED_REVIEW_APPROVAL_NOT_AWAITING = "ignored_review_approval_not_awaiting";
export const IGNORED_REVIEW_APPROVAL_MAINTAINER_REQUIRED =
  "ignored_review_approval_maintainer_required";
export const IGNORED_REVIEW_APPROVAL_NOT_ENABLED = "ignored_review_approval_not_enabled";
export const REVIEW_CANCELLED_PR_CLOSED = "review_cancelled_pr_closed";

export const AUTOMATED_PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "closed"]);
export const DESCRIPTION_PUBLISH_LENS = "description" as const;
export const ASK_PUBLISH_LENS = "ask" as const;
export const TRIAGE_PUBLISH_LENS = "triage" as const;
export const VERIFICATION_PUBLISH_LENS = "verification" as const;
export const MAX_STORED_COMMENT_TEXT_LEN = 16_384;
