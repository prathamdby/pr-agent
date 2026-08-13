import { Buffer } from "node:buffer";
import { isJsonObject, type JsonValue } from "../../src/util/jsonValue.js";

export type PromptCost = {
  readonly bytes: number;
  readonly characters: number;
  readonly estimatedTokens: number;
};

export function measurePromptCost(content: string): PromptCost {
  const characters = Array.from(content).length;
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    characters,
    estimatedTokens: Math.ceil(characters / 4),
  };
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function assertPromptCostWithinBudget(params: {
  readonly name: string;
  readonly content: string;
  readonly budget: PromptCost;
}): PromptCost {
  const cost = measurePromptCost(params.content);
  assertDimension(params.name, "bytes", cost.bytes, params.budget.bytes, cost);
  assertDimension(params.name, "characters", cost.characters, params.budget.characters, cost);
  assertDimension(
    params.name,
    "estimatedTokens",
    cost.estimatedTokens,
    params.budget.estimatedTokens,
    cost,
  );
  return cost;
}

function assertDimension(
  name: string,
  dimension: keyof PromptCost,
  actual: number,
  allowed: number,
  cost: PromptCost,
): void {
  if (actual > allowed) {
    throw new Error(
      `${name} prompt cost exceeded ${dimension} budget: actual=${actual}, allowed=${allowed}, bytes=${cost.bytes}, characters=${cost.characters}, estimatedTokens=${cost.estimatedTokens}`,
    );
  }
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isJsonObject(value)) return value;
  const sorted: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).toSorted()) {
    const child = value[key];
    if (child === undefined) continue;
    sorted[key] = sortJson(child);
  }
  return sorted;
}
