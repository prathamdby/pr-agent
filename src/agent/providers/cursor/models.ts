import type { ModelSelection } from "@cursor/sdk";
import type { Model } from "@earendil-works/pi-ai";
import { CURSOR_API, CURSOR_PROVIDER } from "./constants.js";
import {
  getCursorCatalogById,
  getCursorCatalogItems,
  getFastParamModelIds,
  isCursorModelCapabilitiesInitialized,
} from "./modelCapabilities.js";

export { CURSOR_API, CURSOR_PROVIDER } from "./constants.js";
const CURSOR_FAST_MODEL_SUFFIX = "-fast";

function catalogFastModelIds(): string[] {
  if (!isCursorModelCapabilitiesInitialized()) return [];
  const fastIds = getFastParamModelIds();
  return getCursorCatalogItems()
    .filter((item) => fastIds.has(item.id))
    .map((item) => item.id);
}

export function listCursorModelIds(): string[] {
  const ids = [...getCursorCatalogById().keys()];
  for (const id of catalogFastModelIds()) {
    ids.push(`${id}${CURSOR_FAST_MODEL_SUFFIX}`);
  }
  return ids;
}

export function listTopCursorModelIds(limit = 10): string[] {
  return getCursorCatalogItems()
    .slice(0, limit)
    .map((item) => item.id);
}

function parseCursorModelId(modelId: string): {
  readonly baseId: string;
  readonly fast: boolean;
} {
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
  const { fast } = parseCursorModelId(modelId);
  const catalogId = resolveCursorCatalogId(modelId);
  if (!getFastParamModelIds().has(catalogId)) {
    return { id: catalogId };
  }
  return {
    id: catalogId,
    params: [{ id: "fast", value: fast ? "true" : "false" }],
  };
}

function resolveCursorCatalogId(modelId: string): string {
  const { baseId } = parseCursorModelId(modelId);
  const catalog = getCursorCatalogById();
  if (!catalog.has(baseId)) {
    throw new Error(
      `PI_MODEL "${modelId}" is not a supported Cursor model. Supported: ${listCursorModelIds().join(", ")}`,
    );
  }
  const model = catalog.get(baseId);
  return model?.id ?? baseId;
}

export function assertCursorModelId(modelId: string): void {
  resolveCursorCatalogId(modelId);
}

export function assertCursorModelFastSelection(modelId: string): void {
  const { fast } = parseCursorModelId(modelId);
  if (!fast) return;
  const catalogId = resolveCursorCatalogId(modelId);
  if (!getFastParamModelIds().has(catalogId)) {
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
  const model = getCursorCatalogById().get(baseId);
  if (!model) {
    throw new Error(`Unknown Cursor model id: ${baseId}`);
  }
  return model;
}

export function isCursorProvider(provider: string): boolean {
  return provider === CURSOR_PROVIDER;
}
