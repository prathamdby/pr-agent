import {
  DEFAULT_AGENT_EVENTS_ENABLED,
  DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_REDACT,
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  DEFAULT_PORT,
  DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
  DEFAULT_PI_DURABLE_RESET_MAX_AGE_SECONDS,
  DEFAULT_PI_DURABLE_RESET_MAX_BYTES,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_SQLITE_DIR,
} from "../defaults.ts";
import { ENV } from "../envKeys.ts";
import {
  isProductionNodeEnv,
  optionalEnv,
  readEnum,
  readNonNegativeNumber,
  readPositiveNumber,
  readPositiveInteger,
  readStrictBoolean,
} from "../envReaders.ts";
import { MAX_INLINE_REVIEW_COMMENTS, MAX_THREAD_PUBLISH_CALLS } from "../reviewConstants.ts";

export type RuntimeSlice = {
  readonly port: number;
  readonly sqliteDir: string;
  readonly sqliteDbPath: string | null;
  readonly shutdownGraceMs: number;
  readonly piDurableResetMaxBytes: number;
  readonly piDurableResetMaxAgeSeconds: number;
};

export type AgentEventsSlice = {
  readonly enabled: boolean;
  readonly retentionSeconds: number;
};

export type ReviewSlice = {
  readonly specialistTimeoutMs: number;
  readonly testsEvidence: boolean;
  readonly checkFailSeverity: "P0" | "P1" | "P2" | "P3";
  readonly maxInlineComments: number;
  readonly maxThreadPublishCalls: number;
};

export type PosthogSlice = {
  readonly projectToken: string;
  readonly host: string;
};

export type LoggingSlice = {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly pretty: boolean;
  readonly redact: boolean;
};

export function readRuntimeSlice() {
  const port = readPositiveNumber(ENV.PORT, DEFAULT_PORT);
  const sqliteDir = optionalEnv(ENV.SQLITE_DIR, DEFAULT_SQLITE_DIR).trim() || DEFAULT_SQLITE_DIR;
  const sqliteDbPath = optionalEnv(ENV.SQLITE_DB_PATH, "").trim() || null;
  return ((pinnedReturn: RuntimeSlice) => pinnedReturn)({
    port,
    sqliteDir,
    sqliteDbPath,
    shutdownGraceMs: readPositiveInteger(ENV.SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_GRACE_MS),
    piDurableResetMaxBytes: readPositiveInteger(
      ENV.PI_DURABLE_RESET_MAX_BYTES,
      DEFAULT_PI_DURABLE_RESET_MAX_BYTES,
    ),
    piDurableResetMaxAgeSeconds: readPositiveInteger(
      ENV.PI_DURABLE_RESET_MAX_AGE_SECONDS,
      DEFAULT_PI_DURABLE_RESET_MAX_AGE_SECONDS,
    ),
  });
}

export function readAgentEventsSlice() {
  return ((pinnedReturn: AgentEventsSlice) => pinnedReturn)({
    enabled: readStrictBoolean(ENV.AGENT_EVENTS_ENABLED, DEFAULT_AGENT_EVENTS_ENABLED),
    retentionSeconds: readNonNegativeNumber(
      ENV.AGENT_EVENTS_RETENTION_SECONDS,
      DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
    ),
  });
}

export function readReviewSlice() {
  return ((pinnedReturn: ReviewSlice) => pinnedReturn)({
    testsEvidence: readStrictBoolean(ENV.REVIEW_TESTS_EVIDENCE, false),
    checkFailSeverity: readEnum(
      ENV.REVIEW_CHECK_FAIL_SEVERITY,
      ["P0", "P1", "P2", "P3"] as const,
      "P2",
    ),
    specialistTimeoutMs: readPositiveNumber(
      ENV.REVIEW_SPECIALIST_TIMEOUT_MS,
      DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
    ),
    maxInlineComments: MAX_INLINE_REVIEW_COMMENTS,
    maxThreadPublishCalls: MAX_THREAD_PUBLISH_CALLS,
  });
}

export function readPosthogSlice() {
  return ((pinnedReturn: PosthogSlice) => pinnedReturn)({
    projectToken: optionalEnv(ENV.POSTHOG_PROJECT_TOKEN, DEFAULT_POSTHOG_PROJECT_TOKEN),
    host: optionalEnv(ENV.POSTHOG_HOST, DEFAULT_POSTHOG_HOST).trim(),
  });
}

export function readLoggingSlice() {
  return ((pinnedReturn: LoggingSlice) => pinnedReturn)({
    level: readEnum(ENV.LOG_LEVEL, ["debug", "info", "warn", "error"] as const, DEFAULT_LOG_LEVEL),
    pretty: readStrictBoolean(ENV.LOG_PRETTY, !isProductionNodeEnv()),
    redact: readStrictBoolean(ENV.LOG_REDACT, DEFAULT_LOG_REDACT),
  });
}
