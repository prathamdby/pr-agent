import type { ModelSelection } from "@cursor/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getFastParamModelIds,
  isCursorModelCapabilitiesInitialized,
} from "./modelCapabilities.js";

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

function catalogFastModelIds(): string[] {
  if (!isCursorModelCapabilitiesInitialized()) return [];
  const fastIds = getFastParamModelIds();
  return [...catalogById.keys()].filter((id) => fastIds.has(id));
}

export function listCursorModelIds(): string[] {
  const ids = [...catalogById.keys()];
  for (const id of catalogFastModelIds()) {
    ids.push(`${id}${CURSOR_FAST_MODEL_SUFFIX}`);
  }
  return ids;
}

function parseCursorModelId(modelId: string): { readonly baseId: string; readonly fast: boolean } {
  const trimmed = modelId.trim();
  if (!trimmed.endsWith(CURSOR_FAST_MODEL_SUFFIX)) {
    return { baseId: trimmed, fast: false };
  }
  return {
    baseId: trimmed.slice(0, -CURSOR_FAST_MODEL_SUFFIX.length),
    fast: true,
  };
}

export function toCursorSdkModelSelection(modelId: string): ModelSelection {
  const { baseId, fast } = parseCursorModelId(modelId);
  if (!getFastParamModelIds().has(baseId)) {
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

export function assertCursorModelFastSelection(modelId: string): void {
  const { baseId, fast } = parseCursorModelId(modelId);
  if (!fast) return;
  if (!getFastParamModelIds().has(baseId)) {
    const supportedFast = catalogFastModelIds();
    const hint =
      supportedFast.length > 0
        ? supportedFast.map((id) => `${id}${CURSOR_FAST_MODEL_SUFFIX}`).join(", ")
        : "none";
    throw new Error(`PI_MODEL "${modelId}" does not support fast mode. Supported: ${hint}`);
  }
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
