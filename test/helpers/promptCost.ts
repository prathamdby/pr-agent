import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { isPlainObject } from "../../src/util/typeGuards.js";

export type ParityPrShape = "small" | "medium" | "large" | "docs-only";

export type ParityPrExpectations = {
  readonly findingsParity: "equal";
  readonly maxJudgmentUnpublished: 0;
  readonly citationValidity: "valid";
};

export type ParityPrEntry = {
  readonly id: string;
  readonly shape: ParityPrShape;
  readonly filesChanged: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly docsOnly: boolean;
  readonly fork: boolean;
  readonly securityTouched: boolean;
  readonly expectations: ParityPrExpectations;
};

export type ParityPassThresholds = {
  readonly maxJudgmentUnpublished: 0;
  readonly minCitationValidityRate: 1;
  readonly maxFindingsDrift: 0;
};

export type ParityPrSet = {
  readonly version: 1;
  readonly passThresholds: ParityPassThresholds;
  readonly prs: readonly ParityPrEntry[];
};

const PARITY_FIXTURE_PATH = join(process.cwd(), "test", "__fixtures__", "parityPrSet.json");
const PARITY_SHAPES: readonly ParityPrShape[] = ["small", "medium", "large", "docs-only"];

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseParityExpectations(value: unknown): ParityPrExpectations | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.findingsParity !== "equal") return undefined;
  if (value.maxJudgmentUnpublished !== 0) return undefined;
  if (value.citationValidity !== "valid") return undefined;
  return {
    findingsParity: "equal",
    maxJudgmentUnpublished: 0,
    citationValidity: "valid",
  };
}

function parseParityEntry(value: unknown): ParityPrEntry | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = value.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const shape = value.shape;
  if (typeof shape !== "string" || !PARITY_SHAPES.includes(shape as ParityPrShape))
    return undefined;
  const filesChanged = asNonNegativeInt(value.filesChanged);
  const addedLines = asNonNegativeInt(value.addedLines);
  const deletedLines = asNonNegativeInt(value.deletedLines);
  if (filesChanged == null || addedLines == null || deletedLines == null) return undefined;
  if (typeof value.docsOnly !== "boolean") return undefined;
  if (typeof value.fork !== "boolean") return undefined;
  if (typeof value.securityTouched !== "boolean") return undefined;
  const expectations = parseParityExpectations(value.expectations);
  if (!expectations) return undefined;
  return {
    id,
    shape: shape as ParityPrShape,
    filesChanged,
    addedLines,
    deletedLines,
    docsOnly: value.docsOnly,
    fork: value.fork,
    securityTouched: value.securityTouched,
    expectations,
  };
}

/** Parse and boundary-validate the fixed-PR parity set (fixture holds the data). */
export function parseParityPrSet(json: string): ParityPrSet {
  const parsed: unknown = JSON.parse(json);
  if (!isPlainObject(parsed)) throw new Error("parity set must be a JSON object");
  if (parsed.version !== 1) throw new Error("parity set version must be 1");
  const thresholds = parsed.passThresholds;
  if (!isPlainObject(thresholds)) throw new Error("parity set passThresholds must be an object");
  if (thresholds.maxJudgmentUnpublished !== 0) {
    throw new Error("parity set passThresholds.maxJudgmentUnpublished must be 0");
  }
  if (thresholds.minCitationValidityRate !== 1) {
    throw new Error("parity set passThresholds.minCitationValidityRate must be 1");
  }
  if (thresholds.maxFindingsDrift !== 0) {
    throw new Error("parity set passThresholds.maxFindingsDrift must be 0");
  }
  if (!Array.isArray(parsed.prs)) throw new Error("parity set prs must be an array");
  if (parsed.prs.length < 8 || parsed.prs.length > 12) {
    throw new Error(`parity set must list 8-12 PR shapes, got ${parsed.prs.length}`);
  }
  const prs = parsed.prs.map((entry, index) => {
    const pr = parseParityEntry(entry);
    if (!pr) throw new Error(`parity set prs[${index}] is not a valid parity PR entry`);
    return pr;
  });
  return {
    version: 1,
    passThresholds: {
      maxJudgmentUnpublished: 0,
      minCitationValidityRate: 1,
      maxFindingsDrift: 0,
    },
    prs,
  };
}

/** Load the committed fixed-PR parity set fixture. */
export function loadParityPrSet(fixturePath: string = PARITY_FIXTURE_PATH): ParityPrSet {
  return parseParityPrSet(readFileSync(fixturePath, "utf8"));
}

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

export function stableJson(value: unknown): string {
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

function sortJson(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value != null &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  ) {
    return sortJson(value.toJSON());
  }
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson(value[key])]),
  );
}
