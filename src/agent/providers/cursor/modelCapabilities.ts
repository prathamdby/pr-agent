import { Cursor, type ModelListItem } from "@cursor/sdk";

const FAST_PARAM_ID = "fast";

let fastParamModelIds: ReadonlySet<string> | null = null;

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
  fastParamModelIds = discoverFastParamModelIds(items);
}

export function getFastParamModelIds(): ReadonlySet<string> {
  if (!fastParamModelIds) {
    throw new Error("Cursor model capabilities are not initialized");
  }
  return fastParamModelIds;
}

export function isCursorModelCapabilitiesInitialized(): boolean {
  return fastParamModelIds !== null;
}

export function setCursorModelCapabilitiesForTests(ids: Iterable<string>): void {
  fastParamModelIds = new Set(ids);
}

export function resetCursorModelCapabilitiesForTests(): void {
  fastParamModelIds = null;
}
