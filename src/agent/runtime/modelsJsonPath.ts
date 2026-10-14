import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AppError } from "../../errors/appError.js";

export const MODELS_JSON_FILENAME = "models.json";

export type ResolveModelsJsonPathOptions = {
  readonly cwd?: string;
  readonly explicitPath?: string | null;
};

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
        domain: "settings",
        kind: "models_json_path_not_found",
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
