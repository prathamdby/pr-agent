/** Default values for env-backed settings (see `docs/configuration.md`). */

export const DEFAULT_PORT = 3000;
export const DEFAULT_ROLE = "web" as const;

export const DEFAULT_PI_PROVIDER = "openai";
export const DEFAULT_PI_MODEL = "gpt-4o-mini";

export const DEFAULT_MAX_TOOL_ROUNDS = 24;
export const DEFAULT_MAX_REVIEW_PUBLISH_ATTEMPTS = 3;
export const DEFAULT_MAX_REVIEW_PUBLISH_CALLS = 2;

export const DEFAULT_REVIEW_CONCURRENCY = 2;
export const DEFAULT_ASK_CONCURRENCY = 1;
export const DEFAULT_ACK_CONCURRENCY = 2;

export const DEFAULT_QUEUE_RETRY_LIMIT = 3;
export const DEFAULT_QUEUE_RETRY_DELAY_SECONDS = 30;
export const DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS = 300;
export const DEFAULT_QUEUE_EXPIRE_IN_SECONDS = 3600;
export const DEFAULT_QUEUE_HEARTBEAT_SECONDS = 60;
export const DEFAULT_QUEUE_RETENTION_SECONDS = 1_209_600;
export const DEFAULT_QUEUE_DELETE_AFTER_SECONDS = 604_800;
export const DEFAULT_INSTALLATION_GROUP_CONCURRENCY = 2;

export const DEFAULT_MAX_ASK_TOOL_ROUNDS = 12;
export const DEFAULT_MAX_ASK_FINALIZE_ROUNDS = 2;

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

export const DEFAULT_CONTEXT7_API_KEY = "";

export const DEFAULT_MAX_REVIEW_FINDINGS = 8;
export const DEFAULT_ENABLE_REVIEW_LABELS_EFFORT = true;
export const DEFAULT_ENABLE_REVIEW_LABELS_SECURITY = false;

export const DEFAULT_MAX_PR_FILES_LISTED = 300;
export const DEFAULT_MAX_PR_FILES_PATCH_BYTES = 500_000;

export const DEFAULT_LOG_LEVEL = "info" as const;
export const DEFAULT_LOG_MAX_WIDE_EVENTS = 128;
