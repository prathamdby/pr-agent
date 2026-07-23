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
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_ASK_CONCURRENCY,
  DEFAULT_DESCRIPTION_CONCURRENCY,
  DEFAULT_VERIFICATION_CONCURRENCY,
  DEFAULT_CONTEXT7_API_KEY,
  DEFAULT_CURSOR_API_KEY,
  DEFAULT_CURSOR_RIPGREP_PATH,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  DEFAULT_POSTHOG_HOST,
  DEFAULT_INSTALLATION_GROUP_CONCURRENCY,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_REDACT,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_PROVIDER,
  DEFAULT_PORT,
  DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  DEFAULT_REVIEW_SPECIALIST_TIMEOUT_MS,
  DEFAULT_QUEUE_DELETE_AFTER_SECONDS,
  DEFAULT_QUEUE_EXPIRE_IN_SECONDS,
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
  DEFAULT_TRIAGE_CONCURRENCY,
  DEFAULT_WEBHOOK_EVENTS_RETENTION_SECONDS,
  DEFAULT_AGENT_WORK_RETENTION_SECONDS,
  DEFAULT_RETENTION_CRON,
  DEFAULT_RETENTION_ENABLED,
  ENV,
  EXTERNAL_ENV,
} from "./settings/index.js";
import {
  assertPiModelSelection,
  defaultModelsJsonCandidatePath,
  resolveModelsJsonPath,
} from "./settings/modelsJson.js";

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

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  return optionalEnv(name, String(defaultValue)) === "true";
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

/** Boolean env that rejects typos instead of silently reading them as false. */
function readStrictBoolean(name: string, defaultValue: boolean): boolean {
  return readEnum(name, ["true", "false"] as const, defaultValue ? "true" : "false") === "true";
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
      throw new AppError({
        code: "config.invalid_enum",
        message: `${name} must be "*" or one or more of ${GITHUB_AUTHOR_ASSOCIATIONS.join(", ")}`,
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
  // Still accept "cursor" in the enum so we can emit an explicit migration error
  // instead of a generic unsupported-value message. Never silently fall back to Pi.
  const agentProvider = readEnum(
    ENV.AGENT_PROVIDER,
    ["pi", "cursor"] as const,
    DEFAULT_AGENT_PROVIDER,
  );
  if (agentProvider === "cursor") {
    throw new AppError({
      code: "config.cursor_provider_removed",
      message:
        "AGENT_PROVIDER=cursor is no longer supported. Use the Pi runtime: set AGENT_PROVIDER=pi (or omit it), configure PI_PROVIDER/PI_MODEL (general sessions), optional PI_ORCHESTRATOR_PROVIDER/PI_ORCHESTRATOR_MODEL and PI_FALLBACK_PROVIDER/PI_FALLBACK_MODEL, and resolve models via the Pi built-in catalog or models.json. CURSOR_API_KEY and other Cursor settings are not reinterpreted as Pi credentials.",
      context: { name: ENV.AGENT_PROVIDER, value: "cursor" },
    });
  }

  const piProvider = optionalEnv(ENV.PI_PROVIDER, DEFAULT_PI_PROVIDER);
  const piModel = optionalEnv(ENV.PI_MODEL, DEFAULT_PI_MODEL);
  const modelsJsonPath = resolveModelsJsonPath({
    explicitPath: optionalEnv(ENV.MODELS_JSON_PATH, "").trim() || null,
  });
  const catalogCandidatePath = modelsJsonPath ?? defaultModelsJsonCandidatePath();
  // Cursor ignores models.json for PI_MODEL selection; still require a built-in PI_PROVIDER slug.
  const piApi =
    agentProvider === "pi"
      ? await assertPiModelSelection({
          modelsJsonPath,
          piProvider,
          piModel,
          catalogCandidatePath,
        })
      : await assertPiModelSelection({
          modelsJsonPath: null,
          piProvider,
          piModel,
          catalogCandidatePath,
        });

  const cursorApiKeyRaw = optionalEnv(ENV.CURSOR_API_KEY, DEFAULT_CURSOR_API_KEY);
  if (agentProvider === "cursor" && !cursorApiKeyRaw.trim()) {
    throw new AppError({
      code: "config.missing_env",
      message: `Missing required environment variable: ${ENV.CURSOR_API_KEY}`,
      context: { name: ENV.CURSOR_API_KEY },
    });
  }
  const cursorApiKey = agentProvider === "cursor" ? cursorApiKeyRaw.trim() : cursorApiKeyRaw;
  const cursorRipgrepPath = optionalEnv(
    ENV.CURSOR_RIPGREP_PATH,
    DEFAULT_CURSOR_RIPGREP_PATH,
  ).trim();
  const posthogProjectToken = optionalEnv(ENV.POSTHOG_PROJECT_TOKEN, DEFAULT_POSTHOG_PROJECT_TOKEN);
  const posthogHost = optionalEnv(ENV.POSTHOG_HOST, DEFAULT_POSTHOG_HOST).trim();
  const modelProviderKeys = {
    openai: optionalEnv(EXTERNAL_ENV.OPENAI_API_KEY, ""),
    anthropic: optionalEnv(EXTERNAL_ENV.ANTHROPIC_API_KEY, ""),
    google: optionalEnv(EXTERNAL_ENV.GOOGLE_GENERATIVE_AI_API_KEY, ""),
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
  const slashAllowedAssociations = readSlashAllowedAssociations(
    ENV.SLASH_ALLOWED_ASSOCIATIONS,
    DEFAULT_SLASH_ALLOWED_ASSOCIATIONS,
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
  const retentionEnabled = readBooleanEnv(ENV.RETENTION_ENABLED, DEFAULT_RETENTION_ENABLED);

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

  const logPrettyDefault = process.env.NODE_ENV === "production" ? "false" : "true";
  const logPretty = optionalEnv(ENV.LOG_PRETTY, logPrettyDefault) === "true";
  const logRedact = readBooleanEnv(ENV.LOG_REDACT, DEFAULT_LOG_REDACT);

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
    agentProvider,
    piProvider,
    piModel,
    piApi,
    modelsJsonPath,
    modelProviderKeys,
    providerPromptTimeoutMs,
    reviewSpecialistTimeoutMs,
    reviewConcurrency,
    askConcurrency,
    ackConcurrency,
    descriptionConcurrency,
    triageConcurrency,
    verificationConcurrency,
    slashAllowedAssociations,
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
    context7ApiKey,
    cursorApiKey,
    cursorRipgrepPath,
    posthogProjectToken,
    posthogHost,
    logLevel,
    logPretty,
    logRedact,
  };
}

export type Config = Awaited<ReturnType<typeof loadConfig>>;
