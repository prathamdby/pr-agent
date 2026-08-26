import {
  DESCRIPTION_BODY_BRIEF_BULLET_MAX,
  DESCRIPTION_BODY_BRIEF_BULLET_MIN,
  DESCRIPTION_BODY_BRIEF_MAX_WORDS_PER_BULLET,
  DESCRIPTION_BODY_DETAILED_BULLET_MAX,
  DESCRIPTION_BODY_DETAILED_BULLET_MIN,
  DESCRIPTION_BODY_DETAILED_MAX_WORDS_PER_BULLET,
  DESCRIPTION_BODY_STANDARD_BULLET_MAX,
  DESCRIPTION_BODY_STANDARD_BULLET_MIN,
  DESCRIPTION_BODY_STANDARD_MAX_FILES,
  DESCRIPTION_BODY_STANDARD_MAX_LINE_CHANGES,
  DESCRIPTION_BODY_STANDARD_MAX_WORDS_PER_BULLET,
  DESCRIPTION_MAP_MAX_ENTRIES,
  DESCRIPTION_MAP_OMIT_MAX_FILES,
  DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES,
} from "../../settings/index.js";
import type { DescriptionPayload } from "./descriptionSchema.js";

/** Whether the description agent block publishes a review map. */
export type DescriptionMapMode = "omit" | "read_first";

/**
 * How much prose and technical detail the description body should carry.
 * Derived once per run from workspace size stats.
 */
export type DescriptionBodyScale = "brief" | "standard" | "detailed";

/**
 * How deep the bullets go for reviewers.
 * - what_why: what changed and why it matters
 * - what_why_risk: also notable risks or contracts
 * - what_why_how: also key modules, paths, and review risks
 */
export type DescriptionTechnicalDepth = "what_why" | "what_why_risk" | "what_why_how";

export type DescriptionSizeInput = {
  readonly fileCount: number;
  readonly totalChanges: number;
  readonly truncated: boolean;
};

export type DescriptionWritingPolicy = {
  readonly mapMode: DescriptionMapMode;
  readonly bodyScale: DescriptionBodyScale;
  readonly bulletMin: number;
  readonly bulletMax: number;
  readonly maxWordsPerBullet: number;
  readonly technicalDepth: DescriptionTechnicalDepth;
};

type BodyScaleSpec = {
  readonly bulletMin: number;
  readonly bulletMax: number;
  readonly maxWordsPerBullet: number;
  readonly technicalDepth: DescriptionTechnicalDepth;
};

const BODY_SCALE_SPEC: Record<DescriptionBodyScale, BodyScaleSpec> = {
  brief: {
    bulletMin: DESCRIPTION_BODY_BRIEF_BULLET_MIN,
    bulletMax: DESCRIPTION_BODY_BRIEF_BULLET_MAX,
    maxWordsPerBullet: DESCRIPTION_BODY_BRIEF_MAX_WORDS_PER_BULLET,
    technicalDepth: "what_why",
  },
  standard: {
    bulletMin: DESCRIPTION_BODY_STANDARD_BULLET_MIN,
    bulletMax: DESCRIPTION_BODY_STANDARD_BULLET_MAX,
    maxWordsPerBullet: DESCRIPTION_BODY_STANDARD_MAX_WORDS_PER_BULLET,
    technicalDepth: "what_why_risk",
  },
  detailed: {
    bulletMin: DESCRIPTION_BODY_DETAILED_BULLET_MIN,
    bulletMax: DESCRIPTION_BODY_DETAILED_BULLET_MAX,
    maxWordsPerBullet: DESCRIPTION_BODY_DETAILED_MAX_WORDS_PER_BULLET,
    technicalDepth: "what_why_how",
  },
};

export function resolveDescriptionBodyScale(input: DescriptionSizeInput): DescriptionBodyScale {
  if (input.truncated) return "detailed";
  if (
    input.fileCount <= DESCRIPTION_MAP_OMIT_MAX_FILES &&
    input.totalChanges < DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES
  ) {
    return "brief";
  }
  if (
    input.fileCount <= DESCRIPTION_BODY_STANDARD_MAX_FILES &&
    input.totalChanges < DESCRIPTION_BODY_STANDARD_MAX_LINE_CHANGES
  ) {
    return "standard";
  }
  return "detailed";
}

/** Pair map mode with body scale: brief omits the review map; larger scales keep it. */
export function mapModeForBodyScale(bodyScale: DescriptionBodyScale): DescriptionMapMode {
  return bodyScale === "brief" ? "omit" : "read_first";
}

/**
 * Map mode follows body scale. Truncation forces detailed body scale, so truncated
 * sets always get read_first.
 */
export function resolveDescriptionMapMode(input: DescriptionSizeInput): DescriptionMapMode {
  return mapModeForBodyScale(resolveDescriptionBodyScale(input));
}

/**
 * Single size→behaviour decision for a description run.
 * Owns map mode, bullet budgets, and technical depth together.
 */
export function resolveDescriptionWritingPolicy(
  input: DescriptionSizeInput,
): DescriptionWritingPolicy {
  const bodyScale = resolveDescriptionBodyScale(input);
  const mapMode = mapModeForBodyScale(bodyScale);
  const spec = BODY_SCALE_SPEC[bodyScale];
  return {
    mapMode,
    bodyScale,
    bulletMin: spec.bulletMin,
    bulletMax: spec.bulletMax,
    maxWordsPerBullet: spec.maxWordsPerBullet,
    technicalDepth: spec.technicalDepth,
  };
}

/** Hard-rule prose for technical depth; shared by description body and review overview. */
export function technicalDepthRule(depth: DescriptionTechnicalDepth): string {
  const rules: Record<DescriptionTechnicalDepth, string> = {
    what_why: "Cover what changed and why it matters for reviewers.",
    what_why_risk:
      "Cover what changed, why it matters, and notable risks or contracts the diff touches.",
    what_why_how:
      "Cover what changed, why it matters, how key modules or paths interact, and review risks.",
  };
  return rules[depth];
}

export type EnforceDescriptionMapOptions = {
  readonly maxEntries?: number;
  readonly knownPaths?: ReadonlySet<string>;
};

export function enforceDescriptionMapPayload(
  payload: DescriptionPayload,
  mode: DescriptionMapMode,
  opts: EnforceDescriptionMapOptions = {},
): { payload: DescriptionPayload; strippedCount: number; cappedFrom?: number } {
  const maxEntries = opts.maxEntries ?? DESCRIPTION_MAP_MAX_ENTRIES;

  if (mode === "omit") {
    const strippedCount = payload.prFiles?.length ?? 0;
    if (strippedCount === 0) {
      return { payload, strippedCount: 0 };
    }
    const { prFiles: _removed, ...rest } = payload;
    return { payload: rest, strippedCount };
  }

  const raw = payload.prFiles ?? [];
  let files = raw;
  const knownPaths = opts.knownPaths;
  if (knownPaths && knownPaths.size > 0) {
    files = files.filter((file) => knownPaths.has(file.filename));
  }
  const cappedFrom = files.length > maxEntries ? files.length : undefined;
  if (files.length > maxEntries) {
    files = files.slice(0, maxEntries);
  }

  if (files.length === 0) {
    const { prFiles: _removed, ...rest } = payload;
    return { payload: rest, strippedCount: 0, cappedFrom };
  }

  return {
    payload: { ...payload, prFiles: files },
    strippedCount: 0,
    cappedFrom,
  };
}
