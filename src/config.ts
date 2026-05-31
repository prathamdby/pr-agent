import crypto from "node:crypto";
import { getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import { assertCursorModelId } from "./agent/providers/cursor/models.js";
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
  DEFAULT_LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  DEFAULT_LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  DEFAULT_LOCAL_WORKSPACE_MAX_BLAME_DEEPEN_COMMITS,
  DEFAULT_LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  DEFAULT_LOCAL_WORKSPACE_MAX_FILE_BYTES,
  DEFAULT_LOCAL_WORKSPACE_MAX_MATERIALIZED_FILES,
  DEFAULT_LOCAL_WORKSPACE_MAX_TOTAL_BYTES,
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
  DEFAULT_QUEUE_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_REVIEW_ANCHOR_MENU_MAX_FILES,
  DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
  DEFAULT_REVIEW_INJECT_ANCHOR_MENU,
  DEFAULT_REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
  DEFAULT_ROLE,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
  DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  DEFAULT_RETENTION_CRON,
  DEFAULT_RETENTION_ENABLED,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  ENV,
  EXTERNAL_ENV,
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
  const port = Number(optionalEnv(ENV.PORT, String(DEFAULT_PORT)));
  if (!Number.isFinite(port) || port < 1) throw new Error("PORT must be a positive number");

  const githubAppId = requireEnv(ENV.GITHUB_APP_ID);
  const githubAppPrivateKey = normalizeGithubAppPrivateKey(requireEnv(ENV.GITHUB_APP_PRIVATE_KEY));
  const webhookSecret = requireEnv(ENV.WEBHOOK_SECRET);
  const databaseUrl = requireEnv(ENV.DATABASE_URL);

  const roleRaw = optionalEnv(ENV.ROLE, DEFAULT_ROLE);
  if (!["web", "worker"].includes(roleRaw)) {
    throw new Error("ROLE must be one of web, worker");
  }
  const role = roleRaw as "web" | "worker";

  const agentProviderRaw = optionalEnv(ENV.AGENT_PROVIDER, DEFAULT_AGENT_PROVIDER);
  if (!["pi", "cursor"].includes(agentProviderRaw)) {
    throw new Error("AGENT_PROVIDER must be one of pi, cursor");
  }
  const agentProvider = agentProviderRaw as "pi" | "cursor";

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
  if (agentProvider === "cursor") {
    assertCursorModelId(piModel);
  }
  const cursorApiKey = agentProvider === "cursor" ? cursorApiKeyRaw.trim() : cursorApiKeyRaw;
  const modelProviderKeys = {
    openai: optionalEnv(EXTERNAL_ENV.OPENAI_API_KEY, ""),
    anthropic: optionalEnv(EXTERNAL_ENV.ANTHROPIC_API_KEY, ""),
    google: optionalEnv(EXTERNAL_ENV.GOOGLE_GENERATIVE_AI_API_KEY, ""),
  };

  const maxToolRounds = Number(optionalEnv(ENV.MAX_TOOL_ROUNDS, String(DEFAULT_MAX_TOOL_ROUNDS)));
  if (!Number.isFinite(maxToolRounds) || maxToolRounds < 1) {
    throw new Error("MAX_TOOL_ROUNDS must be a positive number");
  }

  const providerPromptTimeoutMs = readPositiveNumber(
    ENV.PROVIDER_PROMPT_TIMEOUT_MS,
    DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  );

  const maxReviewPublishAttempts = Number(
    optionalEnv(ENV.MAX_REVIEW_PUBLISH_ATTEMPTS, String(DEFAULT_MAX_REVIEW_PUBLISH_ATTEMPTS)),
  );
  if (!Number.isFinite(maxReviewPublishAttempts) || maxReviewPublishAttempts < 1) {
    throw new Error("MAX_REVIEW_PUBLISH_ATTEMPTS must be a positive number");
  }

  const maxReviewPublishCalls = Number(
    optionalEnv(ENV.MAX_REVIEW_PUBLISH_CALLS, String(DEFAULT_MAX_REVIEW_PUBLISH_CALLS)),
  );
  if (!Number.isFinite(maxReviewPublishCalls) || maxReviewPublishCalls < 1) {
    throw new Error("MAX_REVIEW_PUBLISH_CALLS must be a positive number");
  }

  const reviewConcurrency = Number(
    optionalEnv(ENV.REVIEW_CONCURRENCY, String(DEFAULT_REVIEW_CONCURRENCY)),
  );
  if (!Number.isFinite(reviewConcurrency) || reviewConcurrency < 1) {
    throw new Error("REVIEW_CONCURRENCY must be a positive number");
  }

  const askConcurrency = Number(optionalEnv(ENV.ASK_CONCURRENCY, String(DEFAULT_ASK_CONCURRENCY)));
  if (!Number.isFinite(askConcurrency) || askConcurrency < 1) {
    throw new Error("ASK_CONCURRENCY must be a positive number");
  }

  const ackConcurrency = Number(optionalEnv(ENV.ACK_CONCURRENCY, String(DEFAULT_ACK_CONCURRENCY)));
  if (!Number.isFinite(ackConcurrency) || ackConcurrency < 1) {
    throw new Error("ACK_CONCURRENCY must be a positive number");
  }

  const descriptionConcurrency = Number(
    optionalEnv(ENV.DESCRIPTION_CONCURRENCY, String(DEFAULT_DESCRIPTION_CONCURRENCY)),
  );
  if (!Number.isFinite(descriptionConcurrency) || descriptionConcurrency < 1) {
    throw new Error("DESCRIPTION_CONCURRENCY must be a positive number");
  }

  const maxToolRoundsDescribe = Number(
    optionalEnv(ENV.MAX_TOOL_ROUNDS_DESCRIBE, String(DEFAULT_MAX_TOOL_ROUNDS_DESCRIBE)),
  );
  if (!Number.isFinite(maxToolRoundsDescribe) || maxToolRoundsDescribe < 1) {
    throw new Error("MAX_TOOL_ROUNDS_DESCRIBE must be a positive number");
  }

  const descriptionGenerateTitle =
    optionalEnv(ENV.DESCRIPTION_GENERATE_TITLE, String(DEFAULT_DESCRIPTION_GENERATE_TITLE)) ===
    "true";

  const queueRetryLimit = Number(
    optionalEnv(ENV.QUEUE_RETRY_LIMIT, String(DEFAULT_QUEUE_RETRY_LIMIT)),
  );
  if (!Number.isFinite(queueRetryLimit) || queueRetryLimit < 0) {
    throw new Error("QUEUE_RETRY_LIMIT must be zero or a positive number");
  }

  const queueRetryDelaySeconds = Number(
    optionalEnv(ENV.QUEUE_RETRY_DELAY_SECONDS, String(DEFAULT_QUEUE_RETRY_DELAY_SECONDS)),
  );
  if (!Number.isFinite(queueRetryDelaySeconds) || queueRetryDelaySeconds < 0) {
    throw new Error("QUEUE_RETRY_DELAY_SECONDS must be zero or a positive number");
  }

  const queueRetryDelayMaxSeconds = Number(
    optionalEnv(ENV.QUEUE_RETRY_DELAY_MAX_SECONDS, String(DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS)),
  );
  if (!Number.isFinite(queueRetryDelayMaxSeconds) || queueRetryDelayMaxSeconds < 1) {
    throw new Error("QUEUE_RETRY_DELAY_MAX_SECONDS must be a positive number");
  }

  const queueExpireInSeconds = Number(
    optionalEnv(ENV.QUEUE_EXPIRE_IN_SECONDS, String(DEFAULT_QUEUE_EXPIRE_IN_SECONDS)),
  );
  if (!Number.isFinite(queueExpireInSeconds) || queueExpireInSeconds < 1) {
    throw new Error("QUEUE_EXPIRE_IN_SECONDS must be a positive number");
  }

  const queueHeartbeatSeconds = Number(
    optionalEnv(ENV.QUEUE_HEARTBEAT_SECONDS, String(DEFAULT_QUEUE_HEARTBEAT_SECONDS)),
  );
  if (!Number.isFinite(queueHeartbeatSeconds) || queueHeartbeatSeconds < 10) {
    throw new Error("QUEUE_HEARTBEAT_SECONDS must be at least 10");
  }

  const queueRetentionSeconds = Number(
    optionalEnv(ENV.QUEUE_RETENTION_SECONDS, String(DEFAULT_QUEUE_RETENTION_SECONDS)),
  );
  if (!Number.isFinite(queueRetentionSeconds) || queueRetentionSeconds < 1) {
    throw new Error("QUEUE_RETENTION_SECONDS must be a positive number");
  }

  const queueDeleteAfterSeconds = Number(
    optionalEnv(ENV.QUEUE_DELETE_AFTER_SECONDS, String(DEFAULT_QUEUE_DELETE_AFTER_SECONDS)),
  );
  if (!Number.isFinite(queueDeleteAfterSeconds) || queueDeleteAfterSeconds < 0) {
    throw new Error("QUEUE_DELETE_AFTER_SECONDS must be zero or a positive number");
  }

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
  const retentionEnabled =
    optionalEnv(ENV.RETENTION_ENABLED, String(DEFAULT_RETENTION_ENABLED)) === "true";

  const installationGroupConcurrency = Number(
    optionalEnv(ENV.INSTALLATION_GROUP_CONCURRENCY, String(DEFAULT_INSTALLATION_GROUP_CONCURRENCY)),
  );
  if (!Number.isFinite(installationGroupConcurrency) || installationGroupConcurrency < 1) {
    throw new Error("INSTALLATION_GROUP_CONCURRENCY must be a positive number");
  }

  const maxAskToolRounds = Number(
    optionalEnv(ENV.MAX_ASK_TOOL_ROUNDS, String(DEFAULT_MAX_ASK_TOOL_ROUNDS)),
  );
  if (!Number.isFinite(maxAskToolRounds) || maxAskToolRounds < 1) {
    throw new Error("MAX_ASK_TOOL_ROUNDS must be a positive number");
  }

  const maxAskFinalizeRounds = Number(
    optionalEnv(ENV.MAX_ASK_FINALIZE_ROUNDS, String(DEFAULT_MAX_ASK_FINALIZE_ROUNDS)),
  );
  if (!Number.isFinite(maxAskFinalizeRounds) || maxAskFinalizeRounds < 0) {
    throw new Error("MAX_ASK_FINALIZE_ROUNDS must be zero or a positive number");
  }

  const webhookTimeoutMs = Number(
    optionalEnv(ENV.WEBHOOK_TIMEOUT_MS, String(DEFAULT_WEBHOOK_TIMEOUT_MS)),
  );
  if (!Number.isFinite(webhookTimeoutMs) || webhookTimeoutMs < 1) {
    throw new Error("WEBHOOK_TIMEOUT_MS must be a positive number");
  }

  const context7ApiKey = optionalEnv(ENV.CONTEXT7_API_KEY, DEFAULT_CONTEXT7_API_KEY);

  const enableReviewLabelsEffort =
    optionalEnv(ENV.ENABLE_REVIEW_LABELS_EFFORT, String(DEFAULT_ENABLE_REVIEW_LABELS_EFFORT)) ===
    "true";
  const enableReviewLabelsSecurity =
    optionalEnv(
      ENV.ENABLE_REVIEW_LABELS_SECURITY,
      String(DEFAULT_ENABLE_REVIEW_LABELS_SECURITY),
    ) === "true";

  const maxPrFilesListed = Number(
    optionalEnv(ENV.MAX_PR_FILES_LISTED, String(DEFAULT_MAX_PR_FILES_LISTED)),
  );
  if (!Number.isFinite(maxPrFilesListed) || maxPrFilesListed < 1) {
    throw new Error("MAX_PR_FILES_LISTED must be a positive number");
  }

  const maxPrFilesPatchBytes = Number(
    optionalEnv(ENV.MAX_PR_FILES_PATCH_BYTES, String(DEFAULT_MAX_PR_FILES_PATCH_BYTES)),
  );
  if (!Number.isFinite(maxPrFilesPatchBytes) || maxPrFilesPatchBytes < 1) {
    throw new Error("MAX_PR_FILES_PATCH_BYTES must be a positive number");
  }

  const logLevel = optionalEnv(ENV.LOG_LEVEL, DEFAULT_LOG_LEVEL) as
    | "debug"
    | "info"
    | "warn"
    | "error";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error("LOG_LEVEL must be one of debug, info, warn, error");
  }

  const logMaxWideEvents = Number(
    optionalEnv(ENV.LOG_MAX_WIDE_EVENTS, String(DEFAULT_LOG_MAX_WIDE_EVENTS)),
  );
  if (!Number.isFinite(logMaxWideEvents) || logMaxWideEvents < 1) {
    throw new Error("LOG_MAX_WIDE_EVENTS must be a positive number");
  }

  const logPrettyDefault = process.env.NODE_ENV === "production" ? "false" : "true";
  const logPretty = optionalEnv(ENV.LOG_PRETTY, logPrettyDefault) === "true";

  const reviewInjectAnchorMenu =
    optionalEnv(ENV.REVIEW_INJECT_ANCHOR_MENU, String(DEFAULT_REVIEW_INJECT_ANCHOR_MENU)) ===
    "true";
  const reviewRequireDiffCacheBeforeSubmit =
    optionalEnv(
      ENV.REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT,
      String(DEFAULT_REVIEW_REQUIRE_DIFF_CACHE_BEFORE_SUBMIT),
    ) === "true";

  const reviewAnchorMenuMaxFiles = Number(
    optionalEnv(ENV.REVIEW_ANCHOR_MENU_MAX_FILES, String(DEFAULT_REVIEW_ANCHOR_MENU_MAX_FILES)),
  );
  if (!Number.isFinite(reviewAnchorMenuMaxFiles) || reviewAnchorMenuMaxFiles < 1) {
    throw new Error("REVIEW_ANCHOR_MENU_MAX_FILES must be a positive number");
  }

  const reviewAnchorMenuMaxRangesPerFile = Number(
    optionalEnv(
      ENV.REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE,
      String(DEFAULT_REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE),
    ),
  );
  if (!Number.isFinite(reviewAnchorMenuMaxRangesPerFile) || reviewAnchorMenuMaxRangesPerFile < 1) {
    throw new Error("REVIEW_ANCHOR_MENU_MAX_RANGES_PER_FILE must be a positive number");
  }

  const localWorkspaceCloneTimeoutMs = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
    DEFAULT_LOCAL_WORKSPACE_CLONE_TIMEOUT_MS,
  );
  const localWorkspaceFetchTimeoutMs = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
    DEFAULT_LOCAL_WORKSPACE_FETCH_TIMEOUT_MS,
  );
  const localWorkspaceMaxMaterializedFiles = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MAX_MATERIALIZED_FILES,
    DEFAULT_LOCAL_WORKSPACE_MAX_MATERIALIZED_FILES,
  );
  const localWorkspaceMaxFileBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MAX_FILE_BYTES,
    DEFAULT_LOCAL_WORKSPACE_MAX_FILE_BYTES,
  );
  const localWorkspaceMaxTotalBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MAX_TOTAL_BYTES,
    DEFAULT_LOCAL_WORKSPACE_MAX_TOTAL_BYTES,
  );
  const localWorkspaceMaxDiffBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MAX_DIFF_BYTES,
    DEFAULT_LOCAL_WORKSPACE_MAX_DIFF_BYTES,
  );
  const localWorkspaceMinFreeSpaceBytes = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
    DEFAULT_LOCAL_WORKSPACE_MIN_FREE_SPACE_BYTES,
  );
  const localWorkspaceStaleCleanupAgeSeconds = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
    DEFAULT_LOCAL_WORKSPACE_STALE_CLEANUP_AGE_SECONDS,
  );
  const localWorkspaceMaxBlameDeepenCommits = readPositiveNumber(
    ENV.LOCAL_WORKSPACE_MAX_BLAME_DEEPEN_COMMITS,
    DEFAULT_LOCAL_WORKSPACE_MAX_BLAME_DEEPEN_COMMITS,
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
    reviewInjectAnchorMenu,
    reviewRequireDiffCacheBeforeSubmit,
    reviewAnchorMenuMaxFiles,
    reviewAnchorMenuMaxRangesPerFile,
    localWorkspaceCloneTimeoutMs,
    localWorkspaceFetchTimeoutMs,
    localWorkspaceMaxMaterializedFiles,
    localWorkspaceMaxFileBytes,
    localWorkspaceMaxTotalBytes,
    localWorkspaceMaxDiffBytes,
    localWorkspaceMinFreeSpaceBytes,
    localWorkspaceStaleCleanupAgeSeconds,
    localWorkspaceMaxBlameDeepenCommits,
  };
}

export type Config = ReturnType<typeof loadConfig>;
