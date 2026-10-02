import { AppError } from "../../errors/appError.js";
import {
  defaultModelsJsonCandidatePath,
  resolveModelsJsonPath,
} from "../../agent/runtime/modelsJsonPath.js";
import {
  DEFAULT_PI_FALLBACK_MODEL,
  DEFAULT_PI_FALLBACK_PROVIDER,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_ORCHESTRATOR_MODEL,
  DEFAULT_PI_ORCHESTRATOR_PROVIDER,
  DEFAULT_PI_PROVIDER,
  DEFAULT_PI_PROVIDER_MAX_RETRY_DELAY_MS,
  DEFAULT_PI_PROVIDER_RETRY_MAX,
  DEFAULT_PI_THINKING_CEILING,
  DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
} from "../defaults.js";
import { ENV, EXTERNAL_ENV } from "../envKeys.js";
import {
  optionalEnv,
  readEnum,
  readNonNegativeInteger,
  readPositiveNumber,
} from "../envReaders.js";

/** Placeholder api for ROLE=web; worker boot validates and resolves the real Pi api. */
const WEB_UNVALIDATED_PI_API = "web-unvalidated";

const PI_THINKING_CEILINGS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Model selection, the optional `models.json` catalog, and provider API keys. */
export type ModelsSlice = {
  readonly provider: string;
  readonly model: string;
  readonly orchestratorProvider: string;
  readonly orchestratorModel: string;
  readonly fallbackProvider: string;
  readonly fallbackModel: string;
  readonly thinkingCeiling: (typeof PI_THINKING_CEILINGS)[number];
  readonly api: string;
  readonly jsonPath: string | null;
  readonly providerKeys: {
    readonly openai: string;
    readonly anthropic: string;
    readonly google: string;
  };
};

/** Provider call budget and transport retry. */
export type ProviderSlice = {
  readonly promptTimeoutMs: number;
  readonly retryMax: number;
  readonly maxRetryDelayMs: number;
};

export async function readModelsSlice(role: "web" | "worker"): Promise<ModelsSlice> {
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
    PI_THINKING_CEILINGS,
    DEFAULT_PI_THINKING_CEILING,
  );
  const modelsJsonPath = resolveModelsJsonPath({
    explicitPath: optionalEnv(ENV.MODELS_JSON_PATH, "").trim() || null,
  });
  const catalogCandidatePath = modelsJsonPath ?? defaultModelsJsonCandidatePath();
  // Web never creates Pi sessions; worker validates before any agent run.
  let piApi = WEB_UNVALIDATED_PI_API;
  if (role === "worker") {
    const { assertPiModelSelection } = await import("../../agent/runtime/modelsJson.js");
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

  return {
    provider: piProvider,
    model: piModel,
    orchestratorProvider: piOrchestratorProvider,
    orchestratorModel: piOrchestratorModel,
    fallbackProvider: piFallbackProvider,
    fallbackModel: piFallbackModel,
    thinkingCeiling: piThinkingCeiling,
    api: piApi,
    jsonPath: modelsJsonPath,
    providerKeys: {
      openai: optionalEnv(EXTERNAL_ENV.OPENAI_API_KEY, ""),
      anthropic: optionalEnv(EXTERNAL_ENV.ANTHROPIC_API_KEY, ""),
      google: optionalEnv(EXTERNAL_ENV.GOOGLE_GENERATIVE_AI_API_KEY, ""),
    },
  };
}

export function readProviderSlice(): ProviderSlice {
  const promptTimeoutMs = readPositiveNumber(
    ENV.PROVIDER_PROMPT_TIMEOUT_MS,
    DEFAULT_PROVIDER_PROMPT_TIMEOUT_MS,
  );
  const piProviderRetryMax = readNonNegativeInteger(
    ENV.PI_PROVIDER_RETRY_MAX,
    DEFAULT_PI_PROVIDER_RETRY_MAX,
  );
  const piProviderMaxRetryDelayMs = readPositiveNumber(
    ENV.PI_PROVIDER_MAX_RETRY_DELAY_MS,
    DEFAULT_PI_PROVIDER_MAX_RETRY_DELAY_MS,
  );
  if (piProviderMaxRetryDelayMs >= promptTimeoutMs) {
    throw new AppError({
      code: "config.invalid_number",
      message: `${ENV.PI_PROVIDER_MAX_RETRY_DELAY_MS} must be less than ${ENV.PROVIDER_PROMPT_TIMEOUT_MS}`,
      context: {
        name: ENV.PI_PROVIDER_MAX_RETRY_DELAY_MS,
        piProviderMaxRetryDelayMs,
        providerPromptTimeoutMs: promptTimeoutMs,
      },
    });
  }
  return {
    promptTimeoutMs,
    retryMax: piProviderRetryMax,
    maxRetryDelayMs: piProviderMaxRetryDelayMs,
  };
}
