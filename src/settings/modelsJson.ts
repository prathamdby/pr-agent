import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppError } from "../errors/appError.js";

/** Fixed project-root catalog filename (Pi native `models.json` format). */
const MODELS_JSON_FILENAME = "models.json";

export type ResolveModelsJsonPathOptions = {
  readonly cwd?: string;
  /** Absolute or cwd-relative path from `MODELS_JSON_PATH`. When set, the file must exist. */
  readonly explicitPath?: string | null;
};

/** `MODELS_JSON_PATH` when set (must exist); else optional `models.json` under cwd. */
export function resolveModelsJsonPath(
  cwdOrOptions: string | ResolveModelsJsonPathOptions = process.cwd(),
): string | null {
  const options: ResolveModelsJsonPathOptions =
    typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : cwdOrOptions;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.explicitPath?.trim();
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : join(cwd, explicit);
    if (!existsSync(path)) {
      throw new AppError({
        code: "settings.models_json_path_not_found",
        message: `MODELS_JSON_PATH "${path}" does not exist`,
        context: { path },
      });
    }
    return path;
  }
  const path = join(cwd, MODELS_JSON_FILENAME);
  return existsSync(path) ? path : null;
}

export function defaultModelsJsonCandidatePath(cwd: string = process.cwd()): string {
  return join(cwd, MODELS_JSON_FILENAME);
}

function assertNotCursorPiProvider(piProvider: string): void {
  if (piProvider === "cursor") {
    throw new AppError({
      code: "settings.models_json_cursor_provider_deprecated",
      message: "PI_PROVIDER=cursor is no longer supported. Set AGENT_PROVIDER=cursor instead.",
    });
  }
}

function builtinPiApi(piProvider: string, piModel: string): string {
  const model = getModel(piProvider as never, piModel as never);
  if (model?.api) return model.api;
  const fallback = getModels(piProvider as never)[0];
  if (fallback?.api) return fallback.api;
  throw new AppError({
    code: "settings.models_json_unresolvable_api",
    message: `PI_PROVIDER "${piProvider}" has no resolvable API type`,
    context: { piProvider },
  });
}

export function assertBuiltinPiProvider(piProvider: string): void {
  assertNotCursorPiProvider(piProvider);
  const providers = getProviders() as readonly string[];
  if (!providers.includes(piProvider)) {
    throw new AppError({
      code: "settings.models_json_unknown_provider",
      message: `PI_PROVIDER "${piProvider}" is unknown. Pick one of: ${providers.slice(0, 12).join(", ")}…`,
      context: { piProvider, providers: providers.slice(0, 12) },
    });
  }
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
  assertNotCursorPiProvider(piProvider);

  if (!modelsJsonPath) {
    const providers = getProviders() as readonly string[];
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

  const authDir = mkdtempSync(join(tmpdir(), "pr-agent-models-json-"));
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(authDir, "auth.json"),
      modelsPath: modelsJsonPath,
      allowModelNetwork: false,
    });
    const loadError = modelRuntime.getError();
    if (loadError) {
      throw new AppError({
        code: "settings.models_json_load_error",
        message: loadError,
        context: { modelsJsonPath },
      });
    }
    const model = modelRuntime.getModel(piProvider, piModel);
    if (!model) {
      throw new AppError({
        code: "settings.models_json_model_not_found",
        message: `PI_PROVIDER/PI_MODEL "${piProvider}/${piModel}" not found in ${MODELS_JSON_FILENAME} or the built-in catalog`,
        context: { piProvider, piModel },
      });
    }
    return model.api;
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
}
