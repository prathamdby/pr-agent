import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Fixed project-root catalog filename (Pi native `models.json` format). */
export const MODELS_JSON_FILENAME = "models.json";

export function resolveModelsJsonPath(cwd: string = process.cwd()): string | null {
  const path = join(cwd, MODELS_JSON_FILENAME);
  return existsSync(path) ? path : null;
}

function assertNotCursorPiProvider(piProvider: string): void {
  if (piProvider === "cursor") {
    throw new Error(
      "PI_PROVIDER=cursor is no longer supported. Set AGENT_PROVIDER=cursor instead.",
    );
  }
}

function builtinPiApi(piProvider: string, piModel: string): string {
  const model = getModel(piProvider as never, piModel as never);
  if (model?.api) return model.api;
  const fallback = getModels(piProvider as never)[0];
  if (fallback?.api) return fallback.api;
  throw new Error(`PI_PROVIDER "${piProvider}" has no resolvable API type`);
}

export function assertBuiltinPiProvider(piProvider: string): void {
  assertNotCursorPiProvider(piProvider);
  const providers = getProviders() as readonly string[];
  if (!providers.includes(piProvider)) {
    throw new Error(
      `PI_PROVIDER "${piProvider}" is unknown. Pick one of: ${providers.slice(0, 12).join(", ")}…`,
    );
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
}): Promise<string> {
  const { modelsJsonPath, piProvider, piModel } = options;
  assertNotCursorPiProvider(piProvider);

  if (!modelsJsonPath) {
    assertBuiltinPiProvider(piProvider);
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
      throw new Error(loadError);
    }
    const model = modelRuntime.getModel(piProvider, piModel);
    if (!model) {
      throw new Error(
        `PI_PROVIDER/PI_MODEL "${piProvider}/${piModel}" not found in ${MODELS_JSON_FILENAME} or the built-in catalog`,
      );
    }
    return model.api;
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
}
