import { Cursor, type ModelListItem } from "@cursor/sdk";
import type { Model } from "@earendil-works/pi-ai";
import {
  CURSOR_DEFAULT_CONTEXT_WINDOW,
  CURSOR_DEFAULT_MAX_TOKENS,
} from "../../../settings/constants.js";
import { CURSOR_API, CURSOR_PROVIDER } from "./constants.js";

const FAST_PARAM_ID = "fast";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

let catalogItems: readonly ModelListItem[] | null = null;
let catalogById: ReadonlyMap<string, Model<typeof CURSOR_API>> | null = null;
let fastParamModelIds: ReadonlySet<string> | null = null;

function buildCursorModel(item: ModelListItem): Model<typeof CURSOR_API> {
  return {
    id: item.id,
    name: item.displayName,
    api: CURSOR_API,
    provider: CURSOR_PROVIDER,
    baseUrl: "https://cursor.com",
    reasoning: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: CURSOR_DEFAULT_CONTEXT_WINDOW,
    maxTokens: CURSOR_DEFAULT_MAX_TOKENS,
  };
}

function buildCatalogFromItems(
  items: readonly ModelListItem[],
): ReadonlyMap<string, Model<typeof CURSOR_API>> {
  const map = new Map<string, Model<typeof CURSOR_API>>();
  for (const item of items) {
    const model = buildCursorModel(item);
    map.set(item.id, model);
    for (const alias of item.aliases ?? []) {
      map.set(alias, model);
    }
  }
  return map;
}

export function discoverFastParamModelIds(items: readonly ModelListItem[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item.parameters?.some((parameter) => parameter.id === FAST_PARAM_ID)) continue;
    ids.add(item.id);
    for (const alias of item.aliases ?? []) {
      ids.add(alias);
    }
  }
  return ids;
}

export async function initCursorModelCapabilities(apiKey: string): Promise<void> {
  const items = await Cursor.models.list({ apiKey });
  catalogItems = items;
  catalogById = buildCatalogFromItems(items);
  fastParamModelIds = discoverFastParamModelIds(items);
}

export function getCursorCatalogItems(): readonly ModelListItem[] {
  if (!catalogItems) {
    throw new Error("Cursor model capabilities are not initialized");
  }
  return catalogItems;
}

export function getCursorCatalogById(): ReadonlyMap<string, Model<typeof CURSOR_API>> {
  if (!catalogById) {
    throw new Error("Cursor model capabilities are not initialized");
  }
  return catalogById;
}

export function getFastParamModelIds(): ReadonlySet<string> {
  if (!fastParamModelIds) {
    throw new Error("Cursor model capabilities are not initialized");
  }
  return fastParamModelIds;
}

export function isCursorModelCapabilitiesInitialized(): boolean {
  return catalogById !== null;
}

export function setCursorModelsForTests(items: readonly ModelListItem[]): void {
  catalogItems = items;
  catalogById = buildCatalogFromItems(items);
  fastParamModelIds = discoverFastParamModelIds(items);
}

export function resetCursorModelCapabilitiesForTests(): void {
  catalogItems = null;
  catalogById = null;
  fastParamModelIds = null;
}
