import type { ModelSelection } from "@cursor/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";

export const CURSOR_PROVIDER = "cursor";
export const CURSOR_API = "cursor-sdk" as const satisfies Api;
const CURSOR_FAST_MODEL_SUFFIX = "-fast";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type CursorCatalogEntry = {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
};

const CURSOR_MODEL_CATALOG: readonly CursorCatalogEntry[] = [
  { id: "composer-2.5", contextWindow: 200_000, maxTokens: 16_384 },
  { id: "composer-2", contextWindow: 200_000, maxTokens: 16_384 },
  { id: "gpt-5.5", contextWindow: 272_000, maxTokens: 16_384 },
  { id: "claude-opus-4-7", contextWindow: 200_000, maxTokens: 16_384 },
  { id: "auto", contextWindow: 200_000, maxTokens: 16_384 },
] as const;

const CURSOR_FAST_PARAM_MODEL_IDS = new Set(["composer-2.5", "composer-2"]);

function buildCursorModel(entry: CursorCatalogEntry): Model<typeof CURSOR_API> {
  return {
    id: entry.id,
    name: entry.id,
    api: CURSOR_API,
    provider: CURSOR_PROVIDER,
    baseUrl: "https://cursor.com",
    reasoning: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

const catalogById = new Map<string, Model<typeof CURSOR_API>>(
  CURSOR_MODEL_CATALOG.map((entry) => [entry.id, buildCursorModel(entry)]),
);

export function listCursorModelIds(): string[] {
  const ids = [...catalogById.keys()];
  for (const id of CURSOR_FAST_PARAM_MODEL_IDS) {
    ids.push(`${id}${CURSOR_FAST_MODEL_SUFFIX}`);
  }
  return ids;
}

function parseCursorModelId(modelId: string): { readonly baseId: string; readonly fast: boolean } {
  const trimmed = modelId.trim();
  if (!trimmed.endsWith(CURSOR_FAST_MODEL_SUFFIX)) {
    return { baseId: trimmed, fast: false };
  }
  const baseId = trimmed.slice(0, -CURSOR_FAST_MODEL_SUFFIX.length);
  if (!CURSOR_FAST_PARAM_MODEL_IDS.has(baseId)) {
    throw new Error(
      `PI_MODEL "${modelId}" is not a supported Cursor model. Supported: ${listCursorModelIds().join(", ")}`,
    );
  }
  return { baseId, fast: true };
}

export function toCursorSdkModelSelection(modelId: string): ModelSelection {
  const { baseId, fast } = parseCursorModelId(modelId);
  if (!CURSOR_FAST_PARAM_MODEL_IDS.has(baseId)) {
    return { id: baseId };
  }
  return {
    id: baseId,
    params: [{ id: "fast", value: fast ? "true" : "false" }],
  };
}

function resolveCursorCatalogId(modelId: string): string {
  const { baseId } = parseCursorModelId(modelId);
  if (!catalogById.has(baseId)) {
    throw new Error(
      `PI_MODEL "${modelId}" is not a supported Cursor model. Supported: ${listCursorModelIds().join(", ")}`,
    );
  }
  return baseId;
}

export function assertCursorModelId(modelId: string): void {
  resolveCursorCatalogId(modelId);
}

export function getCursorModel(modelId: string): Model<typeof CURSOR_API> {
  const baseId = resolveCursorCatalogId(modelId);
  const model = catalogById.get(baseId);
  if (!model) {
    throw new Error(`Unknown Cursor model id: ${baseId}`);
  }
  return model;
}

export function isCursorProvider(provider: string): boolean {
  return provider === CURSOR_PROVIDER;
}
