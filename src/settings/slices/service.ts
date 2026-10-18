import type { CodeModeExecutorKind } from "../codeModeConstants.ts";
import {
  DEFAULT_AGENT_EVENTS_ENABLED,
  DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
  DEFAULT_CONTEXT7_API_KEY,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_REDACT,
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  DEFAULT_PORT,
  DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
  DEFAULT_ROLE,
} from "../defaults.ts";
import { ENV } from "../envKeys.ts";
import {
  isProductionNodeEnv,
  optionalEnv,
  readEnum,
  readNonNegativeNumber,
  readPositiveNumber,
  readStrictBoolean,
  requireEnv,
} from "../envReaders.ts";
import { MAX_INLINE_REVIEW_COMMENTS, MAX_THREAD_PUBLISH_CALLS } from "../reviewConstants.ts";

export type RuntimeSlice = {
  readonly port: number;
  readonly databaseUrl: string;
  readonly role: "web" | "worker";
};

export type AgentEventsSlice = {
  readonly enabled: boolean;
  readonly retentionSeconds: number;
};

export type CodeModeSlice = {
  readonly executorKind: CodeModeExecutorKind;
};

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
