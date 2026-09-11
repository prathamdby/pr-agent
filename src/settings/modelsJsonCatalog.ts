import { readFile } from "node:fs/promises";
import { AppError } from "../errors/appError.js";
import { isPlainObject } from "../util/typeGuards.js";

const PROVIDER_KEYS = new Set([
  "name",
  "baseUrl",
  "api",
  "apiKey",
  "authHeader",
  "compat",
  "headers",
  "models",
]);

const MODEL_KEYS = new Set([
  "id",
  "name",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
  "cost",
]);

const COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);

const COMPAT_KEYS = new Set(["supportsDeveloperRole", "supportsReasoningEffort"]);

const INPUT_KINDS = new Set(["text", "image"]);

export type ModelsJsonCompat = {
  readonly supportsDeveloperRole?: boolean;
  readonly supportsReasoningEffort?: boolean;
};

export type ModelsJsonCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

export type ModelsJsonModel = {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ReadonlyArray<"text" | "image">;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: ModelsJsonCost;
};

export type ModelsJsonProvider = {
  readonly name?: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKey: string;
  readonly authHeader?: boolean;
  readonly compat?: ModelsJsonCompat;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly ModelsJsonModel[];
};

export type ModelsJsonCatalog = {
  readonly providers: Readonly<Record<string, ModelsJsonProvider>>;
};

function invalidSchema(detail: string): AppError {
  return new AppError({
    code: "settings.models_json_load_error",
    message: `Invalid models.json schema: ${detail}`,
  });
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidSchema(`unknown field ${label}.${key}`);
    }
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidSchema(`${label} must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, label);
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalidSchema(`${label} must be a boolean`);
  return value;
}

function asPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidSchema(`${label} must be a positive number`);
  }
  return value;
}

function asNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidSchema(`${label} must be a non-negative number`);
  }
  return value;
}

export function expandEnvTemplate(value: string): string {
  const braced = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  const bare = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  const name = braced?.[1] ?? bare?.[1];
  if (!name) return value;
  return process.env[name] ?? "";
}

function parseCompat(value: unknown, label: string): ModelsJsonCompat | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw invalidSchema(`${label} must be an object`);
  assertAllowedKeys(value, COMPAT_KEYS, label);
  return {
    ...(value.supportsDeveloperRole !== undefined
      ? {
          supportsDeveloperRole: asBoolean(
            value.supportsDeveloperRole,
            `${label}.supportsDeveloperRole`,
          ),
        }
      : {}),
    ...(value.supportsReasoningEffort !== undefined
      ? {
          supportsReasoningEffort: asBoolean(
            value.supportsReasoningEffort,
            `${label}.supportsReasoningEffort`,
          ),
        }
      : {}),
  };
}

function parseHeaders(value: unknown, label: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw invalidSchema(`${label} must be an object`);
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header !== "string") throw invalidSchema(`${label}.${key} must be a string`);
    headers[key] = header;
  }
  return headers;
}

function parseCost(value: unknown, label: string): ModelsJsonCost {
  if (value === undefined) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  if (!isPlainObject(value)) throw invalidSchema(`${label} must be an object`);
  assertAllowedKeys(value, COST_KEYS, label);
  return {
    input: asNonNegativeNumber(value.input ?? 0, `${label}.input`),
    output: asNonNegativeNumber(value.output ?? 0, `${label}.output`),
    cacheRead: asNonNegativeNumber(value.cacheRead ?? 0, `${label}.cacheRead`),
    cacheWrite: asNonNegativeNumber(value.cacheWrite ?? 0, `${label}.cacheWrite`),
  };
}

function parseInput(value: unknown, label: string): ReadonlyArray<"text" | "image"> {
  if (value === undefined) return ["text"];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidSchema(`${label} must be a non-empty array`);
  }
  const input: Array<"text" | "image"> = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !INPUT_KINDS.has(entry)) {
      throw invalidSchema(`${label} entries must be "text" or "image"`);
    }
    input.push(entry as "text" | "image");
  }
  return input;
}

function parseModel(value: unknown, label: string): ModelsJsonModel {
  if (!isPlainObject(value)) throw invalidSchema(`${label} must be an object`);
  assertAllowedKeys(value, MODEL_KEYS, label);
  const id = asString(value.id, `${label}.id`);
  const contextWindow =
    value.contextWindow === undefined
      ? 128_000
      : asPositiveNumber(value.contextWindow, `${label}.contextWindow`);
  const maxTokens =
    value.maxTokens === undefined
      ? 16_384
      : asPositiveNumber(value.maxTokens, `${label}.maxTokens`);
  return {
    id,
    name: asOptionalString(value.name, `${label}.name`) ?? id,
    reasoning:
      value.reasoning === undefined ? false : asBoolean(value.reasoning, `${label}.reasoning`),
    input: parseInput(value.input, `${label}.input`),
    contextWindow,
    maxTokens,
    cost: parseCost(value.cost, `${label}.cost`),
  };
}

function parseProvider(value: unknown, label: string): ModelsJsonProvider {
  if (!isPlainObject(value)) throw invalidSchema(`${label} must be an object`);
  assertAllowedKeys(value, PROVIDER_KEYS, label);
  if (value.models === undefined || !Array.isArray(value.models) || value.models.length === 0) {
    throw invalidSchema(`${label}.models must be a non-empty array`);
  }
  return {
    ...(value.name !== undefined ? { name: asOptionalString(value.name, `${label}.name`) } : {}),
    baseUrl: asString(value.baseUrl, `${label}.baseUrl`),
    api: asString(value.api, `${label}.api`),
    apiKey: expandEnvTemplate(asString(value.apiKey, `${label}.apiKey`)),
    ...(value.authHeader !== undefined
      ? { authHeader: asBoolean(value.authHeader, `${label}.authHeader`) }
      : {}),
    ...(value.compat !== undefined ? { compat: parseCompat(value.compat, `${label}.compat`) } : {}),
    ...(value.headers !== undefined
      ? { headers: parseHeaders(value.headers, `${label}.headers`) }
      : {}),
    models: value.models.map((model, index) => parseModel(model, `${label}.models[${index}]`)),
  };
}

export function parseModelsJsonCatalog(text: string): ModelsJsonCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidSchema("file is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw invalidSchema("root must be an object");
  assertAllowedKeys(parsed, new Set(["providers"]), "root");
  if (!isPlainObject(parsed.providers)) throw invalidSchema("providers must be an object");
  const providers: Record<string, ModelsJsonProvider> = {};
  for (const [id, provider] of Object.entries(parsed.providers)) {
    if (id.trim().length === 0) throw invalidSchema("provider id must be non-empty");
    providers[id] = parseProvider(provider, `providers.${id}`);
  }
  return { providers };
}

export async function loadModelsJsonCatalog(path: string): Promise<ModelsJsonCatalog> {
  try {
    return parseModelsJsonCatalog(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({
      code: "settings.models_json_load_error",
      message: "Invalid models.json schema",
      context: { modelsJsonPath: path },
      cause: error,
    });
  }
}
