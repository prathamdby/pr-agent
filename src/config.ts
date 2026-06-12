import crypto from "node:crypto";
import { getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import {
  DEFAULT_ACK_CONCURRENCY,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_ASK_CONCURRENCY,
  DEFAULT_DESCRIPTION_CONCURRENCY,
  DEFAULT_DESCRIPTION_GENERATE_TITLE,
  DEFAULT_MAX_TOOL_ROUNDS_DESCRIBE,
  DEFAULT_CONTEXT7_API_KEY,
  DEFAULT_CURSOR_API_KEY,
  DEFAULT_ENABLE_REVIEW_LABELS_EFFORT,
  DEFAULT_ENABLE_REVIEW_LABELS_SECURITY,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_MAX_WIDE_EVENTS,
  DEFAULT_LOG_REDACT,
  DEFAULT_LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  DEFAULT_LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  DEFAULT_LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  DEFAULT_LOCAL_WORKSPACE_MAX_FILE_BYTES,
  DEFAULT_LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
  DEFAULT_LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  DEFAULT_LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  DEFAULT_MAX_ASK_FINALIZE_ROUNDS,
  DEFAULT_MAX_ASK_TOOL_ROUNDS,
  DEFAULT_MAX_PR_FILES_LISTED,
  DEFAULT_MAX_PR_FILES_PATCH_BYTES,
  DEFAULT_MAX_REVIEW_PUBLISH_ATTEMPTS,
  DEFAULT_MAX_REVIEW_PUBLISH_CALLS,
  DEFAULT_MAX_TOOL_ROUNDS,
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
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_REVIEW_ANCHOR_MENU_MAX_FILES,
  DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
  DEFAULT_REVIEW_INJECT_ANCHOR_MENU,
  DEFAULT_REVIEW_MIN_CONFIDENCE,
  DEFAULT_REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
  DEFAULT_ROLE,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
  DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  DEFAULT_RETENTION_CRON,
  DEFAULT_RETENTION_ENABLED,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  ENV,
  EXTERNAL_ENV,
  GITHUB_PULL_REQUEST_FILES_API_MAX_FILES,
} from "./settings/index.js";

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

export function loadConfig() {
  const port = readPositiveNumber(ENV.PORT, DEFAULT_PORT);

  const githubAppId = requireEnv(ENV.GITHUB_APP_ID);
  const githubAppPrivateKey = normalizeGithubAppPrivateKey(requireEnv(ENV.GITHUB_APP_PRIVATE_KEY));
  const webhookSecret = requireEnv(ENV.WEBHOOK_SECRET);
  const databaseUrl = requireEnv(ENV.DATABASE_URL);

  const role = readEnum(ENV.ROLE, ["web", "worker"] as const, DEFAULT_ROLE);
  const agentProvider = readEnum(
    ENV.AGENT_PROVIDER,
    ["pi", "cursor"] as const,
    DEFAULT_AGENT_PROVIDER,
  );

  const piProviderRaw = optionalEnv(ENV.PI_PROVIDER, DEFAULT_PI_PROVIDER);
  const piModel = optionalEnv(ENV.PI_MODEL, DEFAULT_PI_MODEL);
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

  const cursorApiKeyRaw = optionalEnv(ENV.CURSOR_API_KEY, DEFAULT_CURSOR_API_KEY);
  if (agentProvider === "cursor" && !cursorApiKeyRaw.trim()) {
    throw new Error(`Missing required environment variable: ${ENV.CURSOR_API_KEY}`);
  }
  const cursorApiKey = agentProvider === "cursor" ? cursorApiKeyRaw.trim() : cursorApiKeyRaw;
  const modelProviderKeys = {
    openai: optionalEnv(EXTERNAL_ENV.OPENAI_API_KEY, ""),
    anthropic: optionalEnv(EXTERNAL_ENV.ANTHROPIC_API_KEY, ""),
    google: optionalEnv(EXTERNAL_ENV.GOOGLE_GENERATIVE_AI_API_KEY, ""),
  };

  const maxToolRounds = readPositiveNumber(ENV.MAX_TOOL_ROUNDS, DEFAULT_MAX_TOOL_ROUNDS);
  const providerPromptTimeoutMs = readPositiveNumber(
    ENV.PROVIDER_PROMPT_TIMEOUT_MS,
    DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  );
  const maxReviewPublishAttempts = readPositiveNumber(
    ENV.MAX_REVIEW_PUBLISH_ATTEMPTS,
    DEFAULT_MAX_REVIEW_PUBLISH_ATTEMPTS,
  );
  const maxReviewPublishCalls = readPositiveNumber(
    ENV.MAX_REVIEW_PUBLISH_CALLS,
    DEFAULT_MAX_REVIEW_PUBLISH_CALLS,
  );
  const reviewMinConfidence = readIntegerInRange(
    ENV.REVIEW_MIN_CONFIDENCE,
    DEFAULT_REVIEW_MIN_CONFIDENCE,
    1,
    5,
  );
  const reviewConcurrency = readPositiveNumber(ENV.REVIEW_CONCURRENCY, DEFAULT_REVIEW_CONCURRENCY);
  const askConcurrency = readPositiveNumber(ENV.ASK_CONCURRENCY, DEFAULT_ASK_CONCURRENCY);
  const ackConcurrency = readPositiveNumber(ENV.ACK_CONCURRENCY, DEFAULT_ACK_CONCURRENCY);
  const descriptionConcurrency = readPositiveNumber(
    ENV.DESCRIPTION_CONCURRENCY,
    DEFAULT_DESCRIPTION_CONCURRENCY,
  );
  const maxToolRoundsDescribe = readPositiveNumber(
    ENV.MAX_TOOL_ROUNDS_DESCRIBE,
    DEFAULT_MAX_TOOL_ROUNDS_DESCRIBE,
  );
  const descriptionGenerateTitle = readBooleanEnv(
    ENV.DESCRIPTION_GENERATE_TITLE,
    DEFAULT_DESCRIPTION_GENERATE_TITLE,
  );

  const queueRetryLimit = readNonNegativeNumber(ENV.QUEUE_RETRY_LIMIT, DEFAULT_QUEUE_RETRY_LIMIT);
  const queueRetryDelaySeconds = readNonNegativeNumber(
    ENV.QUEUE_RETRY_DELAY_SECONDS,
    DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  );
  const queueRetryDelayMaxSeconds = readPositiveNumber(
    ENV.QUEUE_RETRY_DELAY_MAX_SECONDS,
    DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  );
  const queueExpireInSeconds = readPositiveNumber(
    ENV.QUEUE_EXPIRE_IN_SECONDS,
    DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
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

  const queueRetentionSeconds = readPositiveNumber(
    ENV.QUEUE_RETENTION_SECONDS,
    DEFAULT_QUEUE_RETENTION_SECONDS,
  );
  const queueDeleteAfterSeconds = readNonNegativeNumber(
    ENV.QUEUE_DELETE_AFTER_SECONDS,
    DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  );

  const shutdownDrainTimeoutSeconds = readPositiveNumber(
    ENV.SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
    DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  );

  const webhookEventsRetentionSeconds = readPositiveNumber(
    ENV.WEBHOOK_EVENTS_RETENTION_SECONDS,
    DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
  );
  const agentWorkRetentionSeconds = readPositiveNumber(
    ENV.AGENT_WORK_RETENTION_SECONDS,
    DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  );
  const retentionCron = optionalEnv(ENV.RETENTION_CRON, DEFAULT_RETENTION_CRON);
  const retentionEnabled = readBooleanEnv(ENV.RETENTION_ENABLED, DEFAULT_RETENTION_ENABLED);

  const installationGroupConcurrency = readPositiveNumber(
    ENV.INSTALLATION_GROUP_CONCURRENCY,
    DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  );
  const maxAskToolRounds = readPositiveNumber(ENV.MAX_ASK_TOOL_ROUNDS, DEFAULT_MAX_ASK_TOOL_ROUNDS);
  const maxAskFinalizeRounds = readNonNegativeNumber(
    ENV.MAX_ASK_FINALIZE_ROUNDS,
    DEFAULT_MAX_ASK_FINALIZE_ROUNDS,
  );

  const webhookMaxBodyBytes = readPositiveNumber(
    ENV.WEBHOOK_MAX_BODY_BYTES,
    DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  );
  const webhookTimeoutMs = readPositiveNumber(ENV.WEBHOOK_TIMEOUT_MS, DEFAULT_WEBHOOK_TIMEOUT_MS);

  const context7ApiKey = optionalEnv(ENV.CONTEXT7_API_KEY, DEFAULT_CONTEXT7_API_KEY);

  const enableReviewLabelsEffort = readBooleanEnv(
    ENV.ENABLE_REVIEW_LABELS_EFFORT,
    DEFAULT_ENABLE_REVIEW_LABELS_EFFORT,
  );
  const enableReviewLabelsSecurity = readBooleanEnv(
    ENV.ENABLE_REVIEW_LABELS_SECURITY,
    DEFAULT_ENABLE_REVIEW_LABELS_SECURITY,
  );

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
  const maxPrFilesPatchBytes = readPositiveNumber(
    ENV.MAX_PR_FILES_PATCH_BYTES,
    DEFAULT_MAX_PR_FILES_PATCH_BYTES,
  );

  const logLevel = readEnum(
    ENV.LOG_LEVEL,
    ["debug", "info", "warn", "error"] as const,
    DEFAULT_LOG_LEVEL,
  );

  const logMaxWideEvents = readPositiveNumber(ENV.LOG_MAX_WIDE_EVENTS, DEFAULT_LOG_MAX_WIDE_EVENTS);

  const logPrettyDefault = process.env.NODE_ENV === "production" ? "false" : "true";
  const logPretty = optionalEnv(ENV.LOG_PRETTY, logPrettyDefault) === "true";
  const logRedact = readBooleanEnv(ENV.LOG_REDACT, DEFAULT_LOG_REDACT);

  const reviewInjectAnchorMenu = readBooleanEnv(
    ENV.REVIEW_INJECT_ANCHOR_MENU,
    DEFAULT_REVIEW_INJECT_ANCHOR_MENU,
  );
  const reviewRequireDiffCacheBeforeSubmit = readBooleanEnv(
    ENV.REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
    DEFAULT_REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
  );

  const reviewAnchorMenuMaxFiles = readPositiveNumber(
    ENV.REVIEW_ANCHOR_MENU_MAX_FILES,
    DEFAULT_REVIEW_ANCHOR_MENU_MAX_FILES,
  );
  const reviewAnchorMenuMaxRangesPerFile = readPositiveNumber(
    ENV.REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
    DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
  );

  const localWorkspaceCloneTimeoutMs = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
    DEFAULT_LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  );
  const localWorkspaceFetchTimeoutMs = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    DEFAULT_LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  );
  const localWorkspaceSearchMaxFiles = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_SEARCH_MAX_FILES,
    DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_FILES,
  );
  const localWorkspaceMaxFileBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MAX_FILE_BYTES,
    DEFAULT_LOCAL_WORKSPACE_MAX_FILE_BYTES,
  );
  const localWorkspaceSearchMaxTotalBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
    DEFAULT_LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
  );
  const localWorkspaceMaxDiffBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MAX_DIFF_BYTES,
    DEFAULT_LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  );
  const localWorkspaceMinFreeSpaceBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
    DEFAULT_LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  );
  const localWorkspaceFullCloneMaxRepoKb = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
    DEFAULT_LOCAL_WORKSPACE_FULL_CLONE_MAX_REPO_KB,
  );
  const localWorkspaceStaleCleanupAgeSeconds = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
    DEFAULT_LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  );
  return {
    port,
    githubAppId,
    githubAppPrivateKey,
    webhookSecret,
    databaseUrl,
    role,
    agentProvider,
    piProvider,
    piModel,
    modelProviderKeys,
    maxToolRounds,
    providerPromptTimeoutMs,
    maxReviewPublishAttempts,
    maxReviewPublishCalls,
    reviewMinConfidence,
    reviewConcurrency,
    askConcurrency,
    ackConcurrency,
    descriptionConcurrency,
    maxToolRoundsDescribe,
    descriptionGenerateTitle,
    queueRetryLimit,
    queueRetryDelaySeconds,
    queueRetryDelayMaxSeconds,
    queueExpireInSeconds,
    queueHeartbeatSeconds,
    queuePollingIntervalSeconds,
    queueRetentionSeconds,
    queueDeleteAfterSeconds,
    shutdownDrainTimeoutSeconds,
    webhookEventsRetentionSeconds,
    agentWorkRetentionSeconds,
    retentionCron,
    retentionEnabled,
    installationGroupConcurrency,
    maxAskToolRounds,
    maxAskFinalizeRounds,
    webhookMaxBodyBytes,
    webhookTimeoutMs,
    context7ApiKey,
    cursorApiKey,
    enableReviewLabelsEffort,
    enableReviewLabelsSecurity,
    maxPrFilesListed,
    maxPrFilesPatchBytes,
    logLevel,
    logMaxWideEvents,
    logPretty,
    logRedact,
    reviewInjectAnchorMenu,
    reviewRequireDiffCacheBeforeSubmit,
    reviewAnchorMenuMaxFiles,
    reviewAnchorMenuMaxRangesPerFile,
    localWorkspaceCloneTimeoutMs,
    localWorkspaceFetchTimeoutMs,
    localWorkspaceSearchMaxFiles,
    localWorkspaceMaxFileBytes,
    localWorkspaceSearchMaxTotalBytes,
    localWorkspaceMaxDiffBytes,
    localWorkspaceMinFreeSpaceBytes,
    localWorkspaceFullCloneMaxRepoKb,
    localWorkspaceStaleCleanupAgeSeconds,
  };
}

export type Config = ReturnType<typeof loadConfig>;
