/** Default values for env-backed settings (see `docs/configuration.md`). */

export const DEFAULT_PORT = 3000;
export const DEFAULT_ROLE = "web" as const;

export const DEFAULT_PI_PROVIDER = "openai";
export const DEFAULT_PI_MODEL = "gpt-4o-mini";
/** Empty means inherit general primary (`PI_PROVIDER` / `PI_MODEL`). */
export const DEFAULT_PI_ORCHESTRATOR_PROVIDER = "";
export const DEFAULT_PI_ORCHESTRATOR_MODEL = "";
/** Empty means fallback disabled. */
export const DEFAULT_PI_FALLBACK_PROVIDER = "";
export const DEFAULT_PI_FALLBACK_MODEL = "";
export const DEFAULT_PI_THINKING_CEILING = "high" as const;
/** Empty disables encrypted resume snapshot persistence. */
export const DEFAULT_AGENT_RESUME_SNAPSHOT_KEY = "";
export const DEFAULT_AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS = 600;
export const DEFAULT_AGENT_EVENTS_ENABLED = true;
/** Zero disables agent_events TTL delete; work-item retention + ON DELETE SET NULL still apply. */
export const DEFAULT_AGENT_EVENTS_RETENTION_SECONDS = 0;
export const DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS = 300_000;
export const DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS = 900_000;

export const DEFAULT_REVIEW_CONCURRENCY = 2;
export const DEFAULT_ASK_CONCURRENCY = 1;
export const DEFAULT_ACK_CONCURRENCY = 2;
export const DEFAULT_DESCRIPTION_CONCURRENCY = 1;
export const DEFAULT_TRIAGE_CONCURRENCY = 1;
export const DEFAULT_VERIFICATION_CONCURRENCY = 1;

export const DEFAULT_SLASH_ALLOWED_ASSOCIATIONS = "OWNER,MEMBER,COLLABORATOR";

export const DEFAULT_QUEUE_RETRY_LIMIT = 3;
export const DEFAULT_QUEUE_RETRY_DELAY_SECONDS = 30;
export const DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS = 300;
export const DEFAULT_QUEUE_EXPIRE_IN_SECONDS = 3600;
export const DEFAULT_QUEUE_HEARTBEAT_SECONDS = 60;
export const DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS = 0.5;
export const DEFAULT_QUEUE_RETENTION_SECONDS = 1_209_600;
export const DEFAULT_QUEUE_DELETE_AFTER_SECONDS = 604_800;
export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS = 25;

export const DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS = 2_592_000;
export const DEFAULT_AGENT_WORK_RETENTION_SECONDS = 2_592_000;
export const DEFAULT_RETENTION_CRON = "17 3 * * *";
export const DEFAULT_RETENTION_ENABLED = true;
export const DEFAULT_INSTALLATION_GROUP_CONCURRENCY = 2;

export const DEFAULT_CONTEXT7_API_KEY = "";
export const DEFAULT_POSTHOG_PROJECT_TOKEN = "";
export const DEFAULT_POSTHOG_HOST = "";

export const DEFAULT_LOG_LEVEL = "info" as const;
export const DEFAULT_LOG_REDACT = true;
