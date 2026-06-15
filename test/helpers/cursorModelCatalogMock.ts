import { vi } from "vitest";
import type { ModelListItem } from "@cursor/sdk";
import type { Model } from "@earendil-works/pi-ai";
import { CURSOR_DEFAULT_CONTEXT_WINDOW, CURSOR_DEFAULT_MAX_TOKENS } from "../../src/settings.js";
import { CURSOR_API, CURSOR_PROVIDER } from "../../src/agent/providers/cursor/constants.js";
import { discoverFastParamModelIds } from "../../src/agent/providers/cursor/modelCapabilities.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const catalogState = vi.hoisted(() => ({
  items: null as readonly ModelListItem[] | null,
  byId: null as ReadonlyMap<string, Model<typeof CURSOR_API>> | null,
  fastIds: null as ReadonlySet<string> | null,
}));

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

export function seedCursorModelCatalog(items: readonly ModelListItem[]): void {
  catalogState.items = items;
  catalogState.byId = buildCatalogFromItems(items);
  catalogState.fastIds = discoverFastParamModelIds(items);
}

export function resetCursorModelCatalog(): void {
  catalogState.items = null;
  catalogState.byId = null;
  catalogState.fastIds = null;
}

vi.mock("../../src/agent/providers/cursor/modelCapabilities.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agent/providers/cursor/modelCapabilities.js")>();
  return {
    ...actual,
    initCursorModelCapabilities: vi.fn(async () => undefined),
    getCursorCatalogItems: () => {
      if (!catalogState.items) {
        throw new Error("Cursor model capabilities are not initialized");
      }
      return catalogState.items;
    },
    getCursorCatalogById: () => {
      if (!catalogState.byId) {
        throw new Error("Cursor model capabilities are not initialized");
      }
      return catalogState.byId;
    },
    getFastParamModelIds: () => {
      if (!catalogState.fastIds) {
        throw new Error("Cursor model capabilities are not initialized");
      }
      return catalogState.fastIds;
    },
  };
});
