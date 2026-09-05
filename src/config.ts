import crypto from "node:crypto";
import { AppError } from "./errors/appError.js";
import {
  COMMAND_FEATURE_MODES,
  DEFAULT_FEATURE_ASK,
  DEFAULT_FEATURE_COMMIT_STATUS,
  DEFAULT_FEATURE_DESCRIBE,
  DEFAULT_FEATURE_REVIEW,
  DEFAULT_FEATURE_REVIEW_LABELS,
  DEFAULT_FEATURE_TITLE_REWRITE,
  DEFAULT_FEATURE_TRIAGE,
  DEFAULT_FEATURE_VERIFICATION,
  DESCRIBE_FEATURE_MODES,
  REVIEW_FEATURE_MODES,
  REVIEW_LABELS_MODES,
  VERIFICATION_FEATURE_MODES,
  type Features,
  DEFAULT_ACK_CONCURRENCY,
  DEFAULT_ASK_CONCURRENCY,
  DEFAULT_ASK_ACTOR_BURST,
  DEFAULT_ASK_ACTOR_MAX_OUTSTANDING,
  DEFAULT_ASK_ACTOR_REFILL_SECONDS,
  DEFAULT_ASK_INSTALLATION_BURST,
  DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING,
  DEFAULT_ASK_INSTALLATION_REFILL_SECONDS,
  DEFAULT_ASK_PROVIDER_BUDGET_TOKENS,
  DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
  DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS,
  DEFAULT_ASK_REPOSITORY_BURST,
  DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING,
  DEFAULT_ASK_REPOSITORY_REFILL_SECONDS,
  DEFAULT_DESCRIPTION_CONCURRENCY,
  DEFAULT_VERIFICATION_CONCURRENCY,
  DEFAULT_CONTEXT7_API_KEY,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  DEFAULT_POSTHOG_HOST,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_REDACT,
  DEFAULT_PI_FALLBACK_MODEL,
  DEFAULT_PI_FALLBACK_PROVIDER,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_ORCHESTRATOR_MODEL,
  DEFAULT_PI_ORCHESTRATOR_PROVIDER,
  DEFAULT_PI_PROVIDER,
  DEFAULT_PI_THINKING_CEILING,
  DEFAULT_AGENT_RESUME_SNAPSHOT_KEY,
  DEFAULT_AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS,
  DEFAULT_AGENT_EVENTS_ENABLED,
  DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
  DEFAULT_FINDING_HISTORY_ENABLED,
  DEFAULT_FINDING_HISTORY_DISMISS_SUPPRESS_AFTER,
  DEFAULT_FINDING_HISTORY_LOOKBACK_DAYS,
  DEFAULT_CODE_INDEX_MODE,
  DEFAULT_CODE_INDEX_WAIT_MS,
  DEFAULT_CODE_INDEX_RETENTION_SECONDS,
  CODE_INDEX_MODES,
  DEFAULT_PORT,
  DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
  DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
  DEFAULT_PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
  DEFAULT_PR_ACTOR_LEASE_TTL_SECONDS,
  DEFAULT_QUEUE_HEARTBEAT_SECONDS,
  DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS,
  DEFAULT_QUEUE_RETENTION_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_MAX_SECONDS,
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  DEFAULT_QUEUE_RETRY_LIMIT,
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_ROLE,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_SECONDS,
  DEFAULT_SLASH_ALLOWED_ASSOCIATIONS,
  GITHUB_AUTHOR_ASSOCIATIONS,
  DEFAULT_MAINTAINER_DECISION_ASSOCIATIONS,
  DEFAULT_TRIAGE_CONCURRENCY,
  DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
  DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  DEFAULT_RETENTION_CRON,
  DEFAULT_RETENTION_ENABLED,
  ENV,
  EXTERNAL_ENV,
} from "./settings/index.js";
import {
  defaultModelsJsonCandidatePath,
  resolveModelsJsonPath,
} from "./settings/modelsJsonPath.js";

/** Placeholder api for ROLE=web; worker boot validates and resolves the real Pi api. */
const WEB_UNVALIDATED_PI_API = "web-unvalidated";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new AppError({
      code: "config.missing_env",
      message: `Missing required environment variable: ${name}`,
      context: { name },
    });
  }
  return v;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function readPositiveNumber(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isFinite(value) || value < 1) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${name} must be a positive number`,
      context: { name },
    });
  }
  return value;
}

function readNonNegativeNumber(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${name} must be zero or a positive number`,
      context: { name },
    });
  }
  return value;
}

function readPositiveInteger(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${name} must be a positive integer`,
      context: { name },
    });
  }
  return value;
}

function readNonNegativeInteger(name: string, defaultValue: number): number {
  const value = Number(optionalEnv(name, String(defaultValue)));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${name} must be zero or a non-negative integer`,
      context: { name },
    });
  }
  return value;
}

function readEnum<T extends string>(name: string, allowed: readonly T[], defaultValue: T): T {
  const value = optionalEnv(name, defaultValue);
  if (!allowed.includes(value as T)) {
    throw new AppError({
      code: "config.invalid_enum",
      message: `${name} must be one of ${allowed.join(", ")}`,
      context: { name, allowed },
    });
  }
  return value as T;
}

/**
 * Boolean env that rejects typos instead of silently reading them as false.
 * Empty or whitespace-only values fall back to the default (operator blank = unset).
 */
function readStrictBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }
  if (raw !== "true" && raw !== "false") {
    throw new AppError({
      code: "config.invalid_enum",
      message: `${name} must be one of true, false`,
      context: { name, allowed: ["true", "false"] },
    });
  }
  return raw === "true";
}

const allowedGithubAuthorAssociations = new Set<string>(GITHUB_AUTHOR_ASSOCIATIONS);

function readAssociationAllowlist(
  name: string,
  defaultValue: string,
  allowWildcard: boolean,
): ReadonlySet<string> {
  const values = optionalEnv(name, defaultValue)
    .split(",")
    .map((value) => value.trim().toUpperCase());

  if (allowWildcard && values.length === 1 && values[0] === "*") return new Set(["*"]);

  for (const value of values) {
    if (!allowedGithubAuthorAssociations.has(value)) {
      throw new AppError({
        code: "config.invalid_enum",
        message: `${name} must be ${allowWildcard ? '"*" or ' : ""}one or more of ${GITHUB_AUTHOR_ASSOCIATIONS.join(", ")}`,
        context: { name, allowed: GITHUB_AUTHOR_ASSOCIATIONS },
      });
    }
  }

  return new Set(values);
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
    throw new AppError({
      code: "config.invalid_github_app_private_key",
      message:
        "GITHUB_APP_PRIVATE_KEY must be a valid unencrypted PEM private key. Use the GitHub App private key content with real newlines, escaped \\n newlines, or base64-encoded PEM.",
    });
  }

  return key;
}

export async function loadConfig() {
  const port = readPositiveNumber(ENV.PORT, DEFAULT_PORT);

  const githubAppId = requireEnv(ENV.GITHUB_APP_ID);
  const githubAppPrivateKey = normalizeGithubAppPrivateKey(requireEnv(ENV.GITHUB_APP_PRIVATE_KEY));
  const webhookSecret = requireEnv(ENV.WEBHOOK_SECRET);
  const databaseUrl = requireEnv(ENV.DATABASE_URL);

  const role = readEnum(ENV.ROLE, ["web", "worker"] as const, DEFAULT_ROLE);

  const piProvider = optionalEnv(ENV.PI_PROVIDER, DEFAULT_PI_PROVIDER);
  const piModel = optionalEnv(ENV.PI_MODEL, DEFAULT_PI_MODEL);
  const piOrchestratorProvider = optionalEnv(
    ENV.PI_ORCHESTRATOR_PROVIDER,
    DEFAULT_PI_ORCHESTRATOR_PROVIDER,
  ).trim();
  const piOrchestratorModel = optionalEnv(
    ENV.PI_ORCHESTRATOR_MODEL,
    DEFAULT_PI_ORCHESTRATOR_MODEL,
  ).trim();
  const piFallbackProvider = optionalEnv(
    ENV.PI_FALLBACK_PROVIDER,
    DEFAULT_PI_FALLBACK_PROVIDER,
  ).trim();
  const piFallbackModel = optionalEnv(ENV.PI_FALLBACK_MODEL, DEFAULT_PI_FALLBACK_MODEL).trim();
  if ((piFallbackProvider && !piFallbackModel) || (!piFallbackProvider && piFallbackModel)) {
    throw new AppError({
      code: "config.fallback_model_incomplete",
      message:
        "PI_FALLBACK_PROVIDER and PI_FALLBACK_MODEL must both be set to enable fallback, or both left empty to disable it",
      context: {
        piFallbackProvider,
        piFallbackModel,
      },
    });
  }
  const piThinkingCeiling = readEnum(
    ENV.PI_THINKING_CEILING,
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
    DEFAULT_PI_THINKING_CEILING,
  );
  const agentResumeSnapshotKey = optionalEnv(
    ENV.AGENT_RESUME_SNAPSHOT_KEY,
    DEFAULT_AGENT_RESUME_SNAPSHOT_KEY,
  ).trim();
  const agentResumeSnapshotMarginSeconds = readNonNegativeNumber(
    ENV.AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS,
    DEFAULT_AGENT_RESUME_SNAPSHOT_MARGIN_SECONDS,
  );
  const agentEventsEnabled = readStrictBoolean(
    ENV.AGENT_EVENTS_ENABLED,
    DEFAULT_AGENT_EVENTS_ENABLED,
  );
  const agentEventsRetentionSeconds = readNonNegativeNumber(
    ENV.AGENT_EVENTS_RETENTION_SECONDS,
    DEFAULT_AGENT_EVENTS_RETENTION_SECONDS,
  );
  const findingHistoryEnabled = readStrictBoolean(
    ENV.FINDING_HISTORY_ENABLED,
    DEFAULT_FINDING_HISTORY_ENABLED,
  );
  const findingHistoryDismissSuppressAfter = readPositiveNumber(
    ENV.FINDING_HISTORY_DISMISS_SUPPRESS_AFTER,
    DEFAULT_FINDING_HISTORY_DISMISS_SUPPRESS_AFTER,
  );
  const findingHistoryLookbackDays = readPositiveNumber(
    ENV.FINDING_HISTORY_LOOKBACK_DAYS,
    DEFAULT_FINDING_HISTORY_LOOKBACK_DAYS,
  );
  const codeIndexMode = readEnum(ENV.CODE_INDEX_MODE, CODE_INDEX_MODES, DEFAULT_CODE_INDEX_MODE);
  const codeIndexWaitMs = readNonNegativeNumber(ENV.CODE_INDEX_WAIT_MS, DEFAULT_CODE_INDEX_WAIT_MS);
  const codeIndexRetentionSeconds = readPositiveNumber(
    ENV.CODE_INDEX_RETENTION_SECONDS,
    DEFAULT_CODE_INDEX_RETENTION_SECONDS,
  );
  const modelsJsonPath = resolveModelsJsonPath({
    explicitPath: optionalEnv(ENV.MODELS_JSON_PATH, "").trim() || null,
  });
  const catalogCandidatePath = modelsJsonPath ?? defaultModelsJsonCandidatePath();
  // Web never creates Pi sessions; worker validates before any agent run.
  let piApi = WEB_UNVALIDATED_PI_API;
  if (role === "worker") {
    const { assertPiModelSelection } = await import("./settings/modelsJson.js");
    piApi = await assertPiModelSelection({
      modelsJsonPath,
      piProvider,
      piModel,
      catalogCandidatePath,
    });
    if (piOrchestratorProvider || piOrchestratorModel) {
      await assertPiModelSelection({
        modelsJsonPath,
        piProvider: piOrchestratorProvider || piProvider,
        piModel: piOrchestratorModel || piModel,
        catalogCandidatePath,
      });
    }
    if (piFallbackProvider && piFallbackModel) {
      await assertPiModelSelection({
        modelsJsonPath,
        piProvider: piFallbackProvider,
        piModel: piFallbackModel,
        catalogCandidatePath,
      });
    }
  }

  const posthogProjectToken = optionalEnv(ENV.POSTHOG_PROJECT_TOKEN, DEFAULT_POSTHOG_PROJECT_TOKEN);
  const posthogHost = optionalEnv(ENV.POSTHOG_HOST, DEFAULT_POSTHOG_HOST).trim();
  const openCodeApiKey = optionalEnv(EXTERNAL_ENV.OPENCODE_API_KEY, "");
  const modelProviderKeys = {
    openai: optionalEnv(EXTERNAL_ENV.OPENAI_API_KEY, ""),
    anthropic: optionalEnv(EXTERNAL_ENV.ANTHROPIC_API_KEY, ""),
    google: optionalEnv(EXTERNAL_ENV.GOOGLE_GENERATIVE_AI_API_KEY, ""),
    opencode: openCodeApiKey,
    "opencode-zen": openCodeApiKey,
  };

  const providerPromptTimeoutMs = readPositiveNumber(
    ENV.PROVIDER_PROMPT_TIMEOUT_MS,
    DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  );
  const reviewSpecialistTimeoutMs = readPositiveNumber(
    ENV.REVIEW_SPECIALIST_TIMEOUT_MS,
    DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
  );
  const reviewConcurrency = readPositiveNumber(ENV.REVIEW_CONCURRENCY, DEFAULT_REVIEW_CONCURRENCY);
  const askConcurrency = readPositiveNumber(ENV.ASK_CONCURRENCY, DEFAULT_ASK_CONCURRENCY);
  const askActorMaxOutstanding = readPositiveInteger(
    ENV.ASK_ACTOR_MAX_OUTSTANDING,
    DEFAULT_ASK_ACTOR_MAX_OUTSTANDING,
  );
  const askRepositoryMaxOutstanding = readPositiveInteger(
    ENV.ASK_REPOSITORY_MAX_OUTSTANDING,
    DEFAULT_ASK_REPOSITORY_MAX_OUTSTANDING,
  );
  const askInstallationMaxOutstanding = readPositiveInteger(
    ENV.ASK_INSTALLATION_MAX_OUTSTANDING,
    DEFAULT_ASK_INSTALLATION_MAX_OUTSTANDING,
  );
  const askActorBurst = readPositiveInteger(ENV.ASK_ACTOR_BURST, DEFAULT_ASK_ACTOR_BURST);
  const askRepositoryBurst = readPositiveInteger(
    ENV.ASK_REPOSITORY_BURST,
    DEFAULT_ASK_REPOSITORY_BURST,
  );
  const askInstallationBurst = readPositiveInteger(
    ENV.ASK_INSTALLATION_BURST,
    DEFAULT_ASK_INSTALLATION_BURST,
  );
  const askActorRefillSeconds = readPositiveNumber(
    ENV.ASK_ACTOR_REFILL_SECONDS,
    DEFAULT_ASK_ACTOR_REFILL_SECONDS,
  );
  const askRepositoryRefillSeconds = readPositiveNumber(
    ENV.ASK_REPOSITORY_REFILL_SECONDS,
    DEFAULT_ASK_REPOSITORY_REFILL_SECONDS,
  );
  const askInstallationRefillSeconds = readPositiveNumber(
    ENV.ASK_INSTALLATION_REFILL_SECONDS,
    DEFAULT_ASK_INSTALLATION_REFILL_SECONDS,
  );
  const askProviderBudgetTokens = readNonNegativeInteger(
    ENV.ASK_PROVIDER_BUDGET_TOKENS,
    DEFAULT_ASK_PROVIDER_BUDGET_TOKENS,
  );
  const askProviderBudgetWindowSeconds = readPositiveNumber(
    ENV.ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
    DEFAULT_ASK_PROVIDER_BUDGET_WINDOW_SECONDS,
  );
  const askProviderReservationTokens = readPositiveInteger(
    ENV.ASK_PROVIDER_RESERVATION_TOKENS,
    DEFAULT_ASK_PROVIDER_RESERVATION_TOKENS,
  );
  if (askProviderBudgetTokens > 0 && askProviderReservationTokens > askProviderBudgetTokens) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${ENV.ASK_PROVIDER_RESERVATION_TOKENS} must not exceed ${ENV.ASK_PROVIDER_BUDGET_TOKENS} when the provider budget is enabled`,
      context: {
        name: ENV.ASK_PROVIDER_RESERVATION_TOKENS,
        askProviderBudgetTokens,
        askProviderReservationTokens,
      },
    });
  }
  const ackConcurrency = readPositiveNumber(ENV.ACK_CONCURRENCY, DEFAULT_ACK_CONCURRENCY);
  const descriptionConcurrency = readPositiveNumber(
    ENV.DESCRIPTION_CONCURRENCY,
    DEFAULT_DESCRIPTION_CONCURRENCY,
  );
  const triageConcurrency = readPositiveNumber(ENV.TRIAGE_CONCURRENCY, DEFAULT_TRIAGE_CONCURRENCY);
  const verificationConcurrency = readPositiveNumber(
    ENV.VERIFICATION_CONCURRENCY,
    DEFAULT_VERIFICATION_CONCURRENCY,
  );
  const slashAllowedAssociations = readAssociationAllowlist(
    ENV.SLASH_ALLOWED_ASSOCIATIONS,
    DEFAULT_SLASH_ALLOWED_ASSOCIATIONS,
    true,
  );
  const maintainerDecisionAssociations = readAssociationAllowlist(
    ENV.MAINTAINER_DECISION_ASSOCIATIONS,
    DEFAULT_MAINTAINER_DECISION_ASSOCIATIONS,
    false,
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

  const prActorLeaseTtlSeconds = readPositiveNumber(
    ENV.PR_ACTOR_LEASE_TTL_SECONDS,
    DEFAULT_PR_ACTOR_LEASE_TTL_SECONDS,
  );
  const prActorLeaseRenewalIntervalSeconds = readPositiveNumber(
    ENV.PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
    DEFAULT_PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
  );
  if (prActorLeaseRenewalIntervalSeconds >= prActorLeaseTtlSeconds) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${ENV.PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS} must be less than ${ENV.PR_ACTOR_LEASE_TTL_SECONDS}`,
      context: {
        name: ENV.PR_ACTOR_LEASE_RENEWAL_INTERVAL_SECONDS,
        prActorLeaseTtlSeconds,
        prActorLeaseRenewalIntervalSeconds,
      },
    });
  }

  const queueHeartbeatSeconds = Number(
    optionalEnv(ENV.QUEUE_HEARTBEAT_SECONDS, String(DEFAULT_QUEUE_HEARTBEAT_SECONDS)),
  );
  if (!Number.isFinite(queueHeartbeatSeconds) || queueHeartbeatSeconds < 10) {
    throw new AppError({
      code: "config.invalid_number",
      message: "QUEUE_HEARTBEAT_SECONDS must be at least 10",
      context: { name: ENV.QUEUE_HEARTBEAT_SECONDS },
    });
  }

  const queuePollingIntervalSeconds = Number(
    optionalEnv(ENV.QUEUE_POLLING_INTERVAL_SECONDS, String(DEFAULT_QUEUE_POLLING_INTERVAL_SECONDS)),
  );
  if (!Number.isFinite(queuePollingIntervalSeconds) || queuePollingIntervalSeconds < 0.5) {
    throw new AppError({
      code: "config.invalid_number",
      message: "QUEUE_POLLING_INTERVAL_SECONDS must be at least 0.5",
      context: { name: ENV.QUEUE_POLLING_INTERVAL_SECONDS },
    });
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
  const retentionEnabled = readStrictBoolean(ENV.RETENTION_ENABLED, DEFAULT_RETENTION_ENABLED);

  const installationGroupConcurrency = readPositiveNumber(
    ENV.INSTALLATION_GROUP_CONCURRENCY,
    DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  );

  const context7ApiKey = optionalEnv(ENV.CONTEXT7_API_KEY, DEFAULT_CONTEXT7_API_KEY);

  const logLevel = readEnum(
    ENV.LOG_LEVEL,
    ["debug", "info", "warn", "error"] as const,
    DEFAULT_LOG_LEVEL,
  );

  const logPrettyDefault = process.env.NODE_ENV !== "production";
  const logPretty = readStrictBoolean(ENV.LOG_PRETTY, logPrettyDefault);
  const logRedact = readStrictBoolean(ENV.LOG_REDACT, DEFAULT_LOG_REDACT);

  const features = {
    review: readEnum(ENV.FEATURE_REVIEW, REVIEW_FEATURE_MODES, DEFAULT_FEATURE_REVIEW),
    describe: readEnum(ENV.FEATURE_DESCRIBE, DESCRIBE_FEATURE_MODES, DEFAULT_FEATURE_DESCRIBE),
    verification: readEnum(
      ENV.FEATURE_VERIFICATION,
      VERIFICATION_FEATURE_MODES,
      DEFAULT_FEATURE_VERIFICATION,
    ),
    ask: readEnum(ENV.FEATURE_ASK, COMMAND_FEATURE_MODES, DEFAULT_FEATURE_ASK),
    triage: readEnum(ENV.FEATURE_TRIAGE, COMMAND_FEATURE_MODES, DEFAULT_FEATURE_TRIAGE),
    reviewLabels: readEnum(
      ENV.FEATURE_REVIEW_LABELS,
      REVIEW_LABELS_MODES,
      DEFAULT_FEATURE_REVIEW_LABELS,
    ),
    commitStatus: readStrictBoolean(ENV.FEATURE_COMMIT_STATUS, DEFAULT_FEATURE_COMMIT_STATUS),
    titleRewrite: readStrictBoolean(ENV.FEATURE_TITLE_REWRITE, DEFAULT_FEATURE_TITLE_REWRITE),
  } satisfies Features;

  return {
    port,
    githubAppId,
    githubAppPrivateKey,
    webhookSecret,
    databaseUrl,
    role,
    features,
    piProvider,
    piModel,
    piOrchestratorProvider,
    piOrchestratorModel,
    piFallbackProvider,
    piFallbackModel,
    piThinkingCeiling,
    agentResumeSnapshotKey,
    agentResumeSnapshotMarginSeconds,
    agentEventsEnabled,
    agentEventsRetentionSeconds,
    findingHistoryEnabled,
    findingHistoryDismissSuppressAfter,
    findingHistoryLookbackDays,
    codeIndexMode,
    codeIndexWaitMs,
    codeIndexRetentionSeconds,
    piApi,
    modelsJsonPath,
    modelProviderKeys,
    providerPromptTimeoutMs,
    reviewSpecialistTimeoutMs,
    reviewConcurrency,
    askConcurrency,
    askActorMaxOutstanding,
    askRepositoryMaxOutstanding,
    askInstallationMaxOutstanding,
    askActorBurst,
    askRepositoryBurst,
    askInstallationBurst,
    askActorRefillSeconds,
    askRepositoryRefillSeconds,
    askInstallationRefillSeconds,
    askProviderBudgetTokens,
    askProviderBudgetWindowSeconds,
    askProviderReservationTokens,
    ackConcurrency,
    descriptionConcurrency,
    triageConcurrency,
    verificationConcurrency,
    slashAllowedAssociations,
    maintainerDecisionAssociations,
    queueRetryLimit,
    queueRetryDelaySeconds,
    queueRetryDelayMaxSeconds,
    queueExpireInSeconds,
    prActorLeaseTtlSeconds,
    prActorLeaseRenewalIntervalSeconds,
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
    context7ApiKey,
    posthogProjectToken,
    posthogHost,
    logLevel,
    logPretty,
    logRedact,
  };
}

export type Config = Awaited<ReturnType<typeof loadConfig>>;
