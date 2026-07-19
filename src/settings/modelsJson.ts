import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviders } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Fixed project-root catalog filename (Pi native `models.json` format). */
export const MODELS_JSON_FILENAME = "models.json";

export function resolveModelsJsonPath(cwd: string = process.cwd()): string | null {
  const path = join(cwd, MODELS_JSON_FILENAME);
  return existsSync(path) ? path : null;
}

export function assertBuiltinPiProvider(piProvider: string): void {
  if (piProvider === "cursor") {
    throw new Error(
      "PI_PROVIDER=cursor is no longer supported. Set AGENT_PROVIDER=cursor instead.",
    );
  }
  const providers = getProviders() as readonly string[];
  if (!providers.includes(piProvider)) {
    throw new Error(
      `PI_PROVIDER "${piProvider}" is unknown. Pick one of: ${providers.slice(0, 12).join(", ")}…`,
    );
  }
}

/** Validate PI_PROVIDER / PI_MODEL against built-ins, or built-ins ∪ models.json when present. */
export function assertPiModelSelection(options: {
  readonly modelsJsonPath: string | null;
  readonly piProvider: string;
  readonly piModel: string;
}): void {
  const { modelsJsonPath, piProvider, piModel } = options;

  if (!modelsJsonPath) {
    assertBuiltinPiProvider(piProvider);
    return;
  }

  if (piProvider === "cursor") {
    throw new Error(
      "PI_PROVIDER=cursor is no longer supported. Set AGENT_PROVIDER=cursor instead.",
    );
  }

  const authDir = mkdtempSync(join(tmpdir(), "pr-agent-models-json-"));
  try {
    const authStorage = AuthStorage.create(join(authDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath);
    const loadError = modelRegistry.getError();
    if (loadError) {
      throw new Error(loadError);
    }
    const model = modelRegistry.find(piProvider, piModel);
    if (!model) {
      throw new Error(
        `PI_PROVIDER/PI_MODEL "${piProvider}/${piModel}" not found in ${MODELS_JSON_FILENAME} or the built-in catalog`,
      );
    }
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
}
