import type { Api, Model } from "@earendil-works/pi-ai";

export const CURSOR_PROVIDER = "cursor";
export const CURSOR_API = "cursor-sdk" as const satisfies Api;

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

const DEFAULT_CURSOR_MODEL_ID = "composer-2.5";

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

export function getCursorModel(modelId: string): Model<typeof CURSOR_API> {
  return catalogById.get(modelId) ?? catalogById.get(DEFAULT_CURSOR_MODEL_ID)!;
}

export function listCursorModelIds(): string[] {
  return [...catalogById.keys()];
}

export function isCursorProvider(provider: string): boolean {
  return provider === CURSOR_PROVIDER;
}
