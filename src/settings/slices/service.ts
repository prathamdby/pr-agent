import { CODE_INDEX_MODES } from "../codeIndexConstants.js";
import type { CodeModeExecutorKind } from "../codeModeConstants.js";
import {
  DEFAULT_AGENT_EVENTS_ENABLED,
  DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
  DEFAULT_CODE_INDEX_MODE,
  DEFAULT_CODE_INDEX_RETENTION_SECONDS,
  DEFAULT_CODE_INDEX_WAIT_MS,
  DEFAULT_CONTEXT7_API_KEY,
  DEFAULT_FINDING_HISTORY_DISMISS_SUPPRESS_AFTER,
  DEFAULT_FINDING_HISTORY_ENABLED,
  DEFAULT_FINDING_HISTORY_LOOKBACK_DAYS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_REDACT,
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  DEFAULT_PORT,
  DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
  DEFAULT_ROLE,
} from "../defaults.js";
import { ENV } from "../envKeys.js";
import {
  isProductionNodeEnv,
  optionalEnv,
  readEnum,
  readNonNegativeNumber,
  readPositiveNumber,
  readStrictBoolean,
  requireEnv,
} from "../envReaders.js";
import { MAX_INLINE_REVIEW_COMMENTS, MAX_THREAD_PUBLISH_CALLS } from "../reviewConstants.js";

export type RuntimeSlice = {
  readonly port: number;
  readonly databaseUrl: string;
  readonly role: "web" | "worker";
};

export type AgentEventsSlice = {
  readonly enabled: boolean;
  readonly retentionSeconds: number;
};

export type FindingHistorySlice = {
  readonly enabled: boolean;
  readonly dismissSuppressAfter: number;
  readonly lookbackDays: number;
};

export type CodeIndexSlice = {
  readonly mode: (typeof CODE_INDEX_MODES)[number];
  readonly waitMs: number;
  readonly retentionSeconds: number;
};

/** Which executor Code Mode scripts run in. Derived from the build, not from an env var. */
export type CodeModeSlice = {
  readonly executorKind: CodeModeExecutorKind;
};

/** Specialist timeout plus the publish caps that are code constants, not env knobs. */
export type ReviewSlice = {
  readonly specialistTimeoutMs: number;
  readonly recoveryEnabled: boolean;
  readonly maxInlineComments: number;
  readonly maxThreadPublishCalls: number;
};

export type Context7Slice = {
  readonly apiKey: string;
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

export function readRuntimeSlice(): RuntimeSlice {
  const port = readPositiveNumber(ENV.PORT, DEFAULT_PORT);
  const databaseUrl = requireEnv(ENV.DATABASE_URL);
  const role = readEnum(ENV.ROLE, ["web", "worker"] as const, DEFAULT_ROLE);
  return { port, databaseUrl, role };
}

export function readAgentEventsSlice(): AgentEventsSlice {
  return {
    enabled: readStrictBoolean(ENV.AGENT_EVENTS_ENABLED, DEFAULT_AGENT_EVENTS_ENABLED),
    retentionSeconds: readNonNegativeNumber(
      ENV.AGENT_EVENTS_RETENTION_SECONDS,
      DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
    ),
  };
}

export function readFindingHistorySlice(): FindingHistorySlice {
  return {
    enabled: readStrictBoolean(ENV.FINDING_HISTORY_ENABLED, DEFAULT_FINDING_HISTORY_ENABLED),
    dismissSuppressAfter: readPositiveNumber(
      ENV.FINDING_HISTORY_DISMISS_SUPPRESS_AFTER,
      DEFAULT_FINDING_HISTORY_DISMISS_SUPPRESS_AFTER,
    ),
    lookbackDays: readPositiveNumber(
      ENV.FINDING_HISTORY_LOOKBACK_DAYS,
      DEFAULT_FINDING_HISTORY_LOOKBACK_DAYS,
    ),
  };
}

export function readCodeIndexSlice(): CodeIndexSlice {
  return {
    mode: readEnum(ENV.CODE_INDEX_MODE, CODE_INDEX_MODES, DEFAULT_CODE_INDEX_MODE),
    waitMs: readNonNegativeNumber(ENV.CODE_INDEX_WAIT_MS, DEFAULT_CODE_INDEX_WAIT_MS),
    retentionSeconds: readPositiveNumber(
      ENV.CODE_INDEX_RETENTION_SECONDS,
      DEFAULT_CODE_INDEX_RETENTION_SECONDS,
    ),
  };
}

/**
 * Compiled production runs worker threads. TypeScript sources (dev, Vitest) stay
 * in-process so the interrupt remains observable and the worker file need not
 * exist beside `.ts` sources.
 */
export function readCodeModeSlice(): CodeModeSlice {
  return { executorKind: import.meta.url.endsWith(".js") ? "worker_threads" : "in_process" };
}

export function readReviewSlice(): ReviewSlice {
  return {
    recoveryEnabled: readStrictBoolean(ENV.REVIEW_RECOVERY_ENABLED, false),
    specialistTimeoutMs: readPositiveNumber(
      ENV.REVIEW_SPECIALIST_TIMEOUT_MS,
      DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
    ),
    maxInlineComments: MAX_INLINE_REVIEW_COMMENTS,
    maxThreadPublishCalls: MAX_THREAD_PUBLISH_CALLS,
  };
}

export function readContext7Slice(): Context7Slice {
  return { apiKey: optionalEnv(ENV.CONTEXT7_API_KEY, DEFAULT_CONTEXT7_API_KEY) };
}

export function readPosthogSlice(): PosthogSlice {
  return {
    projectToken: optionalEnv(ENV.POSTHOG_PROJECT_TOKEN, DEFAULT_POSTHOG_PROJECT_TOKEN),
    host: optionalEnv(ENV.POSTHOG_HOST, DEFAULT_POSTHOG_HOST).trim(),
  };
}

export function readLoggingSlice(): LoggingSlice {
  return {
    level: readEnum(ENV.LOG_LEVEL, ["debug", "info", "warn", "error"] as const, DEFAULT_LOG_LEVEL),
    pretty: readStrictBoolean(ENV.LOG_PRETTY, !isProductionNodeEnv()),
    redact: readStrictBoolean(ENV.LOG_REDACT, DEFAULT_LOG_REDACT),
  };
}
