import crypto from "node:crypto";
import { getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import {
  AUTOMATED_PR_ACTIONS,
  DEFAULT_ACK_CONCURRENCY,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  DEFAULT_ASK_CONCURRENCY,
  DEFAULT_CONTEXT7_API_KEY,
  DEFAULT_CURSOR_API_KEY,
  DEFAULT_DESCRIPTION_AUTO_ACTIONS,
  DEFAULT_DESCRIPTION_CONCURRENCY,
  DEFAULT_DESCRIPTION_GENERATE_TITLE,
  DEFAULT_ENABLE_REVIEW_COMMIT_STATUS,
  DEFAULT_ENABLE_REVIEW_LABELS_EFFORT,
  DEFAULT_ENABLE_REVIEW_LABELS_SECURITY,
  DEFAULT_ENABLE_THREAD_REPLIES,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  DEFAULT_LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  DEFAULT_LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  DEFAULT_LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  DEFAULT_LOCAL_WORKSPACE_MAX_FETCH_BYTES,
  DEFAULT_LOCAL_WORKSPACE_MAX_FILE_BYTES,
  DEFAULT_LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
  DEFAULT_LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_MAX_WIDE_EVENTS,
  DEFAULT_LOG_REDACT,
  DEFAULT_MAX_ASK_FINALIZE_ROUNDS,
  DEFAULT_MAX_ASK_TOOL_ROUNDS,
  DEFAULT_MAX_PR_FILES_LISTED,
  DEFAULT_MAX_PR_FILES_PATCH_BYTES,
  DEFAULT_MAX_REVIEW_PUBLISH_ATTEMPTS,
  DEFAULT_MAX_REVIEW_PUBLISH_CALLS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_MAX_TOOL_ROUNDS_DESCRIBE,
  DEFAULT_MAX_TOOL_ROUNDS_TRIAGE,
  DEFAULT_MAX_TRIAGE_FIXES_PER_RUN,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_PROVIDER,
  DEFAULT_PORT,
  DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  DEFAULT_QUEUE_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_RETENTION_CRON,
  DEFAULT_RETENTION_ENABLED,
  DEFAULT_REVIEW_ANCHOR_MENU_MAX_FILES,
  DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_REVIEW_INJECT_ANCHOR_MENU,
  DEFAULT_REVIEW_MIN_CONFIDENCE,
  DEFAULT_REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
  DEFAULT_ROLE,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  DEFAULT_SLASH_ALLOWED_ASSOCIATIONS,
  DEFAULT_TRIAGE_CONCURRENCY,
  DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  ENV,
  GITHUB_PULL_REQUEST_FILES_API_MAX_FILES,
} from "./settings.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function readPositiveNumber(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function readNonNegativeNumber(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be zero or a positive number`);
  }
  return value;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  return optionalEnv(name, String(defaultValue)) === "true";
}

function readEnum<T extends string>(name: string, allowed: readonly T[], defaultValue: T): T {
  const value = optionalEnv(name, defaultValue);
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const GITHUB_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
  "MANNEQUIN",
] as const;

const allowedGithubAuthorAssociations = new Set<string>(GITHUB_AUTHOR_ASSOCIATIONS);

function readSlashAllowedAssociations(name: string, defaultValue: string): ReadonlySet<string> {
  const values = optionalEnv(name, defaultValue)
    .split(",")
    .map((value) => value.trim().toUpperCase());

  if (values.length === 1 && values[0] === "*") return new Set(["*"]);

  for (const value of values) {
    if (!allowedGithubAuthorAssociations.has(value)) {
      throw new Error(
        `${name} must be "*" or one or more of ${GITHUB_AUTHOR_ASSOCIATIONS.join(", ")}`,
      );
    }
  }

  return new Set(values);
}

function readDescriptionAutoActions(name: string, defaultValue: string): ReadonlySet<string> {
  const values = optionalEnv(name, defaultValue)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new Error(`${name} must list at least one pull_request action`);
  }
  for (const value of values) {
    if (!AUTOMATED_PR_ACTIONS.has(value)) {
      throw new Error(
        `${name} contains unknown action "${value}"; allowed: ${[...AUTOMATED_PR_ACTIONS].join(", ")}`,
      );
    }
  }
  return new Set(values);
}

function readIntegerInRange(name: string, defaultValue: number, min: number, max: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikePemPrivateKey(value: string): boolean {
  return value.includes("-----BEGIN ") && value.includes("PRIVATE KEY-----");
}

function decodeBase64Pem(value: string): string | null {
  const compact = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return null;
  }

  const decoded = Buffer.from(compact, "base64").toString("utf8").trim();
  return looksLikePemPrivateKey(decoded) ? decoded : null;
}

export function normalizeGithubAppPrivateKey(raw: string): string {
  const unquoted = stripMatchingQuotes(raw.trim());
  let key = unquoted.replace(/\\n/g, "\n");

  if (!looksLikePemPrivateKey(key)) {
    const decoded = decodeBase64Pem(unquoted);
    if (decoded) key = decoded.replace(/\\n/g, "\n");
  }

  try {
    crypto.createPrivateKey(key);
  } catch {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY must be a valid unencrypted PEM private key. Use the GitHub App private key content with real newlines, escaped \\n newlines, or base64-encoded PEM.",
    );
  }

  return key;
}

type EnvLoaderSpec =
  | { out: string; env: string; kind: "positive"; default: number }
  | { out: string; env: string; kind: "non_negative"; default: number }
  | { out: string; env: string; kind: "bool"; default: boolean }
  | { out: string; env: string; kind: "string"; default: string }
  | { out: string; env: string; kind: "enum"; default: string; allowed: readonly string[] }
  | { out: string; env: string; kind: "int_range"; default: number; min: number; max: number };

const ENV_LOADERS: readonly EnvLoaderSpec[] = [
  { out: "port", env: ENV.PORT, kind: "positive", default: DEFAULT_PORT },
  { out: "role", env: ENV.ROLE, kind: "enum", default: DEFAULT_ROLE, allowed: ["web", "worker"] },
  {
    out: "agentProvider",
    env: ENV.AGENT_PROVIDER,
    kind: "enum",
    default: DEFAULT_AGENT_PROVIDER,
    allowed: ["pi", "cursor"],
  },
  { out: "piModel", env: ENV.PI_MODEL, kind: "string", default: DEFAULT_PI_MODEL },
  {
    out: "maxToolRounds",
    env: ENV.MAX_TOOL_ROUNDS,
    kind: "positive",
    default: DEFAULT_MAX_TOOL_ROUNDS,
  },
  {
    out: "providerPromptTimeoutMs",
    env: ENV.PROVIDER_PROMPT_TIMEOUT_MS,
    kind: "positive",
    default: DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  },
  {
    out: "maxReviewPublishAttempts",
    env: ENV.MAX_REVIEW_PUBLISH_ATTEMPTS,
    kind: "positive",
    default: DEFAULT_MAX_REVIEW_PUBLISH_ATTEMPTS,
  },
  {
    out: "maxReviewPublishCalls",
    env: ENV.MAX_REVIEW_PUBLISH_CALLS,
    kind: "positive",
    default: DEFAULT_MAX_REVIEW_PUBLISH_CALLS,
  },
  {
    out: "reviewMinConfidence",
    env: ENV.REVIEW_MIN_CONFIDENCE,
    kind: "int_range",
    default: DEFAULT_REVIEW_MIN_CONFIDENCE,
    min: 1,
    max: 5,
  },
  {
    out: "reviewConcurrency",
    env: ENV.REVIEW_CONCURRENCY,
    kind: "positive",
    default: DEFAULT_REVIEW_CONCURRENCY,
  },
  {
    out: "askConcurrency",
    env: ENV.ASK_CONCURRENCY,
    kind: "positive",
    default: DEFAULT_ASK_CONCURRENCY,
  },
  {
    out: "ackConcurrency",
    env: ENV.ACK_CONCURRENCY,
    kind: "positive",
    default: DEFAULT_ACK_CONCURRENCY,
  },
  {
    out: "descriptionConcurrency",
    env: ENV.DESCRIPTION_CONCURRENCY,
    kind: "positive",
    default: DEFAULT_DESCRIPTION_CONCURRENCY,
  },
  {
    out: "triageConcurrency",
    env: ENV.TRIAGE_CONCURRENCY,
    kind: "positive",
    default: DEFAULT_TRIAGE_CONCURRENCY,
  },
  {
    out: "maxToolRoundsDescribe",
    env: ENV.MAX_TOOL_ROUNDS_DESCRIBE,
    kind: "positive",
    default: DEFAULT_MAX_TOOL_ROUNDS_DESCRIBE,
  },
  {
    out: "maxToolRoundsTriage",
    env: ENV.MAX_TOOL_ROUNDS_TRIAGE,
    kind: "positive",
    default: DEFAULT_MAX_TOOL_ROUNDS_TRIAGE,
  },
  {
    out: "maxTriageFixesPerRun",
    env: ENV.MAX_TRIAGE_FIXES_PER_RUN,
    kind: "positive",
    default: DEFAULT_MAX_TRIAGE_FIXES_PER_RUN,
  },
  {
    out: "descriptionGenerateTitle",
    env: ENV.DESCRIPTION_GENERATE_TITLE,
    kind: "bool",
    default: DEFAULT_DESCRIPTION_GENERATE_TITLE,
  },
  {
    out: "queueRetryLimit",
    env: ENV.QUEUE_RETRY_LIMIT,
    kind: "non_negative",
    default: DEFAULT_QUEUE_RETRY_LIMIT,
  },
  {
    out: "queueRetryDelaySeconds",
    env: ENV.QUEUE_RETRY_DELAY_SECONDS,
    kind: "non_negative",
    default: DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  },
  {
    out: "queueRetryDelayMaxSeconds",
    env: ENV.QUEUE_RETRY_DELAY_MAX_SECONDS,
    kind: "positive",
    default: DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  },
  {
    out: "queueExpireInSeconds",
    env: ENV.QUEUE_EXPIRE_IN_SECONDS,
    kind: "positive",
    default: DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  },
  {
    out: "queueRetentionSeconds",
    env: ENV.QUEUE_RETENTION_SECONDS,
    kind: "positive",
    default: DEFAULT_QUEUE_RETENTION_SECONDS,
  },
  {
    out: "queueDeleteAfterSeconds",
    env: ENV.QUEUE_DELETE_AFTER_SECONDS,
    kind: "non_negative",
    default: DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  },
  {
    out: "shutdownDrainTimeoutSeconds",
    env: ENV.SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
    kind: "positive",
    default: DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  },
  {
    out: "webhookEventsRetentionSeconds",
    env: ENV.WEBHOOK_EVENTS_RETENTION_SECONDS,
    kind: "positive",
    default: DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
  },
  {
    out: "agentWorkRetentionSeconds",
    env: ENV.AGENT_WORK_RETENTION_SECONDS,
    kind: "positive",
    default: DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  },
  {
    out: "retentionCron",
    env: ENV.RETENTION_CRON,
    kind: "string",
    default: DEFAULT_RETENTION_CRON,
  },
  {
    out: "retentionEnabled",
    env: ENV.RETENTION_ENABLED,
    kind: "bool",
    default: DEFAULT_RETENTION_ENABLED,
  },
  {
    out: "installationGroupConcurrency",
    env: ENV.INSTALLATION_GROUP_CONCURRENCY,
    kind: "positive",
    default: DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  },
  {
    out: "maxAskToolRounds",
    env: ENV.MAX_ASK_TOOL_ROUNDS,
    kind: "positive",
    default: DEFAULT_MAX_ASK_TOOL_ROUNDS,
  },
  {
    out: "maxAskFinalizeRounds",
    env: ENV.MAX_ASK_FINALIZE_ROUNDS,
    kind: "non_negative",
    default: DEFAULT_MAX_ASK_FINALIZE_ROUNDS,
  },
  {
    out: "webhookMaxBodyBytes",
    env: ENV.WEBHOOK_MAX_BODY_BYTES,
    kind: "positive",
    default: DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  },
  {
    out: "webhookTimeoutMs",
    env: ENV.WEBHOOK_TIMEOUT_MS,
    kind: "positive",
    default: DEFAULT_WEBHOOK_TIMEOUT_MS,
  },
  {
    out: "context7ApiKey",
    env: ENV.CONTEXT7_API_KEY,
    kind: "string",
    default: DEFAULT_CONTEXT7_API_KEY,
  },
  {
    out: "enableReviewLabelsEffort",
    env: ENV.ENABLE_REVIEW_LABELS_EFFORT,
    kind: "bool",
    default: DEFAULT_ENABLE_REVIEW_LABELS_EFFORT,
  },
  {
    out: "enableReviewLabelsSecurity",
    env: ENV.ENABLE_REVIEW_LABELS_SECURITY,
    kind: "bool",
    default: DEFAULT_ENABLE_REVIEW_LABELS_SECURITY,
  },
  {
    out: "enableThreadReplies",
    env: ENV.ENABLE_THREAD_REPLIES,
    kind: "bool",
    default: DEFAULT_ENABLE_THREAD_REPLIES,
  },
  {
    out: "enableReviewCommitStatus",
    env: ENV.ENABLE_REVIEW_COMMIT_STATUS,
    kind: "bool",
    default: DEFAULT_ENABLE_REVIEW_COMMIT_STATUS,
  },
  {
    out: "maxPrFilesPatchBytes",
    env: ENV.MAX_PR_FILES_PATCH_BYTES,
    kind: "positive",
    default: DEFAULT_MAX_PR_FILES_PATCH_BYTES,
  },
  {
    out: "logLevel",
    env: ENV.LOG_LEVEL,
    kind: "enum",
    default: DEFAULT_LOG_LEVEL,
    allowed: ["debug", "info", "warn", "error"],
  },
  {
    out: "logMaxWideEvents",
    env: ENV.LOG_MAX_WIDE_EVENTS,
    kind: "positive",
    default: DEFAULT_LOG_MAX_WIDE_EVENTS,
  },
  {
    out: "logRedact",
    env: ENV.LOG_REDACT,
    kind: "bool",
    default: DEFAULT_LOG_REDACT,
  },
  {
    out: "reviewInjectAnchorMenu",
    env: ENV.REVIEW_INJECT_ANCHOR_MENU,
    kind: "bool",
    default: DEFAULT_REVIEW_INJECT_ANCHOR_MENU,
  },
  {
    out: "reviewRequireDiffCacheBeforeSubmit",
    env: ENV.REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
    kind: "bool",
    default: DEFAULT_REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
  },
  {
    out: "reviewAnchorMenuMaxFiles",
    env: ENV.REVIEW_ANCHOR_MENU_MAX_FILES,
    kind: "positive",
    default: DEFAULT_REVIEW_ANCHOR_MENU_MAX_FILES,
  },
  {
    out: "reviewAnchorMenuMaxRangesPerFile",
    env: ENV.REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
    kind: "positive",
    default: DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
  },
  {
    out: "localWorkspaceCloneTimeoutMs",
    env: ENV.LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  },
  {
    out: "localWorkspaceFetchTimeoutMs",
    env: ENV.LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  },
  {
    out: "localWorkspaceSearchMaxFiles",
    env: ENV.LOCAL_WORKSPACE_SEARCH_MAX_FILES,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  },
  {
    out: "localWorkspaceMaxFileBytes",
    env: ENV.LOCAL_WORKSPACE_MAX_FILE_BYTES,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_MAX_FILE_BYTES,
  },
  {
    out: "localWorkspaceSearchMaxTotalBytes",
    env: ENV.LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
  },
  {
    out: "localWorkspaceMaxDiffBytes",
    env: ENV.LOCAL_WORKSPACE_MAX_DIFF_BYTES,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  },
  {
    out: "localWorkspaceMinFreeSpaceBytes",
    env: ENV.LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  },
  {
    out: "localWorkspaceMaxFetchBytes",
    env: ENV.LOCAL_WORKSPACE_MAX_FETCH_BYTES,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_MAX_FETCH_BYTES,
  },
  {
    out: "localWorkspaceFullCloneMaxRepoKb",
    env: ENV.LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  },
  {
    out: "localWorkspaceStaleCleanupAgeSeconds",
    env: ENV.LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
    kind: "positive",
    default: DEFAULT_LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  },
];

function loadEnvField(spec: EnvLoaderSpec): unknown {
  switch (spec.kind) {
    case "positive":
      return readPositiveNumber(spec.env, spec.default);
    case "non_negative":
      return readNonNegativeNumber(spec.env, spec.default);
    case "bool":
      return readBooleanEnv(spec.env, spec.default);
    case "string":
      return optionalEnv(spec.env, spec.default);
    case "enum":
      return readEnum(spec.env, spec.allowed, spec.default);
    case "int_range":
      return readIntegerInRange(spec.env, spec.default, spec.min, spec.max);
    default: {
      throw new Error(`Unhandled env loader kind: ${(spec as EnvLoaderSpec).kind}`);
    }
  }
}

type TableConfig = {
  port: number;
  role: "web" | "worker";
  agentProvider: "pi" | "cursor";
  piModel: string;
  maxToolRounds: number;
  providerPromptTimeoutMs: number;
  maxReviewPublishAttempts: number;
  maxReviewPublishCalls: number;
  reviewMinConfidence: number;
  reviewConcurrency: number;
  askConcurrency: number;
  ackConcurrency: number;
  descriptionConcurrency: number;
  triageConcurrency: number;
  maxToolRoundsDescribe: number;
  maxToolRoundsTriage: number;
  maxTriageFixesPerRun: number;
  descriptionGenerateTitle: boolean;
  queueRetryLimit: number;
  queueRetryDelaySeconds: number;
  queueRetryDelayMaxSeconds: number;
  queueExpireInSeconds: number;
  queueRetentionSeconds: number;
  queueDeleteAfterSeconds: number;
  shutdownDrainTimeoutSeconds: number;
  webhookEventsRetentionSeconds: number;
  agentWorkRetentionSeconds: number;
  retentionCron: string;
  retentionEnabled: boolean;
  installationGroupConcurrency: number;
  maxAskToolRounds: number;
  maxAskFinalizeRounds: number;
  webhookMaxBodyBytes: number;
  webhookTimeoutMs: number;
  context7ApiKey: string;
  enableReviewLabelsEffort: boolean;
  enableReviewLabelsSecurity: boolean;
  enableThreadReplies: boolean;
  enableReviewCommitStatus: boolean;
  maxPrFilesPatchBytes: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logMaxWideEvents: number;
  logRedact: boolean;
  reviewInjectAnchorMenu: boolean;
  reviewRequireDiffCacheBeforeSubmit: boolean;
  reviewAnchorMenuMaxFiles: number;
  reviewAnchorMenuMaxRangesPerFile: number;
  localWorkspaceCloneTimeoutMs: number;
  localWorkspaceFetchTimeoutMs: number;
  localWorkspaceSearchMaxFiles: number;
  localWorkspaceMaxFileBytes: number;
  localWorkspaceSearchMaxTotalBytes: number;
  localWorkspaceMaxDiffBytes: number;
  localWorkspaceMinFreeSpaceBytes: number;
  localWorkspaceMaxFetchBytes: number;
  localWorkspaceFullCloneMaxRepoKb: number;
  localWorkspaceStaleCleanupAgeSeconds: number;
};

function loadEnvTable(): TableConfig {
  const loaded: Record<string, unknown> = {};
  for (const spec of ENV_LOADERS) {
    loaded[spec.out] = loadEnvField(spec);
  }
  return loaded as TableConfig;
}

export function loadConfig() {
  const table = loadEnvTable();

  const githubAppId = requireEnv(ENV.GITHUB_APP_ID);
  const githubAppPrivateKey = normalizeGithubAppPrivateKey(requireEnv(ENV.GITHUB_APP_PRIVATE_KEY));
  const webhookSecret = requireEnv(ENV.WEBHOOK_SECRET);
  const databaseUrl = requireEnv(ENV.DATABASE_URL);

  const piProviderRaw = optionalEnv(ENV.PI_PROVIDER, DEFAULT_PI_PROVIDER);
  const providers = getProviders() as readonly string[];
  if (piProviderRaw === "cursor") {
    throw new Error(
      "PI_PROVIDER=cursor is no longer supported. Set AGENT_PROVIDER=cursor instead.",
    );
  }
  if (!providers.includes(piProviderRaw)) {
    throw new Error(
      `PI_PROVIDER "${piProviderRaw}" is unknown. Pick one of: ${providers.slice(0, 12).join(", ")}…`,
    );
  }
  const piProvider = piProviderRaw as KnownProvider;

  const agentProvider = table.agentProvider;
  const cursorApiKeyRaw = optionalEnv(ENV.CURSOR_API_KEY, DEFAULT_CURSOR_API_KEY);
  if (agentProvider === "cursor" && !cursorApiKeyRaw.trim()) {
    throw new Error(`Missing required environment variable: ${ENV.CURSOR_API_KEY}`);
  }
  const cursorApiKey = agentProvider === "cursor" ? cursorApiKeyRaw.trim() : cursorApiKeyRaw;
  const modelProviderKeys = {
    openai: optionalEnv(ENV.OPENAI_API_KEY, ""),
    anthropic: optionalEnv(ENV.ANTHROPIC_API_KEY, ""),
    google: optionalEnv(ENV.GOOGLE_GENERATIVE_AI_API_KEY, ""),
  };

  const slashAllowedAssociations = readSlashAllowedAssociations(
    ENV.SLASH_ALLOWED_ASSOCIATIONS,
    DEFAULT_SLASH_ALLOWED_ASSOCIATIONS,
  );
  const descriptionAutoActions = readDescriptionAutoActions(
    ENV.DESCRIPTION_AUTO_ACTIONS,
    DEFAULT_DESCRIPTION_AUTO_ACTIONS,
  );

  const queueHeartbeatSeconds = Number(
    optionalEnv(ENV.QUEUE_HEARTBEAT_SECONDS, String(DEFAULT_QUEUE_HEARTBEAT_SECONDS)),
  );
  if (!Number.isFinite(queueHeartbeatSeconds) || queueHeartbeatSeconds < 10) {
    throw new Error("QUEUE_HEARTBEAT_SECONDS must be at least 10");
  }

  const queuePollingIntervalSeconds = Number(
    optionalEnv(ENV.QUEUE_POLLING_INTERVAL_SECONDS, String(DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS)),
  );
  if (!Number.isFinite(queuePollingIntervalSeconds) || queuePollingIntervalSeconds < 0.5) {
    throw new Error("QUEUE_POLLING_INTERVAL_SECONDS must be at least 0.5");
  }

  const logPrettyDefault = process.env.NODE_ENV === "production" ? "false" : "true";
  const logPretty = optionalEnv(ENV.LOG_PRETTY, logPrettyDefault) === "true";

  const configuredMaxPrFilesListed = readPositiveNumber(
    ENV.MAX_PR_FILES_LISTED,
    DEFAULT_MAX_PR_FILES_LISTED,
  );
  const maxPrFilesListed = Math.min(
    configuredMaxPrFilesListed,
    GITHUB_PULL_REQUEST_FILES_API_MAX_FILES,
  );
  if (configuredMaxPrFilesListed > GITHUB_PULL_REQUEST_FILES_API_MAX_FILES) {
    console.warn(
      `${ENV.MAX_PR_FILES_LISTED}=${configuredMaxPrFilesListed} exceeds GitHub pull request files API cap ${GITHUB_PULL_REQUEST_FILES_API_MAX_FILES}; using ${GITHUB_PULL_REQUEST_FILES_API_MAX_FILES}.`,
    );
  }

  return {
    ...table,
    githubAppId,
    githubAppPrivateKey,
    webhookSecret,
    databaseUrl,
    piProvider,
    cursorApiKey,
    modelProviderKeys,
    slashAllowedAssociations,
    descriptionAutoActions,
    queueHeartbeatSeconds,
    queuePollingIntervalSeconds,
    logPretty,
    maxPrFilesListed,
  };
}

export type Config = ReturnType<typeof loadConfig>;
