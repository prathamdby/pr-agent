import {
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Api,
  type KnownApi,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import {
  builtinModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { AppError, isAppError } from "../errors/appError.js";
import {
  loadModelsJsonCatalog,
  type ModelsJsonCompat,
  type ModelsJsonModel,
  type ModelsJsonProvider,
} from "./modelsJsonCatalog.js";
import { defaultModelsJsonCandidatePath, MODELS_JSON_FILENAME } from "./modelsJsonPath.js";

export {
  defaultModelsJsonCandidatePath,
  MODELS_JSON_FILENAME,
  resolveModelsJsonPath,
  type ResolveModelsJsonPathOptions,
} from "./modelsJsonPath.js";

const KNOWN_API_STREAMS: Record<KnownApi, () => ProviderStreams> = {
  "openai-responses": openAIResponsesApi,
  "openai-completions": openAICompletionsApi,
  "openai-codex-responses": openAICodexResponsesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "google-vertex": googleVertexApi,
  "mistral-conversations": mistralConversationsApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "pi-messages": piMessagesApi,
};

function isKnownApi(api: string): api is KnownApi {
  return Object.hasOwn(KNOWN_API_STREAMS, api);
}

function streamsForApi(api: string): ProviderStreams {
  if (!isKnownApi(api)) {
    throw new AppError({
      code: "settings.models_json_load_error",
      message: `Invalid models.json schema: unknown provider api: ${api}`,
    });
  }
  return KNOWN_API_STREAMS[api]();
}

function toPiModel(
  providerId: string,
  baseUrl: string,
  api: string,
  entry: ModelsJsonModel,
  compat: ModelsJsonCompat | undefined,
): Model<Api> {
  return {
    id: entry.id,
    name: entry.name,
    api,
    provider: providerId,
    baseUrl,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: { ...entry.cost },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    ...(compat ? { compat } : {}),
  };
}

function catalogApiKeyAuth(
  providerId: string,
  catalogKey: string,
  authHeader: boolean | undefined,
  headers: Readonly<Record<string, string>> | undefined,
) {
  const fallback = envApiKeyAuth(`${providerId} API key`, [
    `${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`,
  ]);
  return {
    name: `${providerId} API key`,
    resolve: async (input: Parameters<typeof fallback.resolve>[0]) => {
      const stored = await fallback.resolve(input);
      const key = stored?.auth.apiKey || catalogKey || undefined;
      if (!key) return undefined;
      const merged = { ...headers };
      if (authHeader) merged.Authorization = `Bearer ${key}`;
      return {
        auth: {
          apiKey: key,
          ...(Object.keys(merged).length > 0 ? { headers: merged } : {}),
        },
        source: stored?.source ?? "models.json",
      };
    },
  };
}

function overlayProvider(
  models: MutableModels,
  providerId: string,
  provider: ModelsJsonProvider,
): void {
  models.setProvider(
    createProvider({
      id: providerId,
      name: provider.name ?? providerId,
      baseUrl: provider.baseUrl,
      headers: provider.headers ? { ...provider.headers } : undefined,
      auth: {
        apiKey: catalogApiKeyAuth(
          providerId,
          provider.apiKey,
          provider.authHeader,
          provider.headers,
        ),
      },
      models: provider.models.map((entry) =>
        toPiModel(providerId, provider.baseUrl, provider.api, entry, provider.compat),
      ),
      api: streamsForApi(provider.api),
    }),
  );
}

export async function overlayCatalog(
  catalogPath: string | null,
  credentials: InMemoryCredentialStore,
): Promise<MutableModels> {
  const models = builtinModels({ credentials });
  if (!catalogPath) return models;
  const catalog = await loadModelsJsonCatalog(catalogPath);
  for (const [id, provider] of Object.entries(catalog.providers)) {
    if (provider.apiKey.length > 0) {
      await credentials.modify(id, async () => ({ type: "api_key", key: provider.apiKey }));
    }
    overlayProvider(models, id, provider);
  }
  return models;
}

function builtinPiApi(piProvider: string, piModel: string): string {
  try {
    const model = getBuiltinModel(piProvider as never, piModel as never);
    if (model?.api) return model.api;
  } catch {
    // Provider or model is not in the generated catalog.
  }
  const fallback = getBuiltinModels(piProvider as never)[0];
  if (fallback?.api) return fallback.api;
  throw new AppError({
    code: "settings.models_json_unresolvable_api",
    message: `PI_PROVIDER "${piProvider}" has no resolvable API type`,
    context: { piProvider },
  });
}

/**
 * Validate PI_PROVIDER / PI_MODEL against built-ins, or built-ins ∪ models.json when present.
 * Returns the resolved Pi `api` type for AssistantMessage stubs.
 */
export async function assertPiModelSelection(options: {
  readonly modelsJsonPath: string | null;
  readonly piProvider: string;
  readonly piModel: string;
  /** Path shown in the missing-catalog error (cwd `models.json` or MODELS_JSON_PATH). */
  readonly catalogCandidatePath?: string;
}): Promise<string> {
  const { modelsJsonPath, piProvider, piModel } = options;

  if (!modelsJsonPath) {
    const providers = getBuiltinProviders() as readonly string[];
    if (!providers.includes(piProvider)) {
      const lookedFor = options.catalogCandidatePath ?? defaultModelsJsonCandidatePath();
      throw new AppError({
        code: "settings.models_json_unknown_provider_no_catalog",
        message: `PI_PROVIDER "${piProvider}" is unknown and no models.json catalog was loaded (looked for ${lookedFor}). Mount or copy ${MODELS_JSON_FILENAME} into the process cwd, or set MODELS_JSON_PATH. Built-ins: ${providers.slice(0, 12).join(", ")}…`,
        context: {
          piProvider,
          lookedFor,
          providers: providers.slice(0, 12),
        },
      });
    }
    return builtinPiApi(piProvider, piModel);
  }

  try {
    const credentials = new InMemoryCredentialStore();
    const models = await overlayCatalog(modelsJsonPath, credentials);
    const model = models.getModel(piProvider, piModel);
    if (!model) {
      throw new AppError({
        code: "settings.models_json_model_not_found",
        message: `PI_PROVIDER/PI_MODEL "${piProvider}/${piModel}" not found in ${MODELS_JSON_FILENAME} or the built-in catalog`,
        context: { piProvider, piModel },
      });
    }
    return model.api;
  } catch (error) {
    if (isAppError(error)) throw error;
    throw new AppError({
      code: "settings.models_json_load_error",
      message: "Invalid models.json schema",
      context: { modelsJsonPath },
      cause: error,
    });
  }
}
