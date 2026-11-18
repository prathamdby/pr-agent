import {
  DESCRIPTION_BODY_L_BULLET_MAX,
  DESCRIPTION_BODY_L_BULLET_MIN,
  DESCRIPTION_BODY_L_MAX_WORDS_PER_BULLET,
  DESCRIPTION_BODY_M_BULLET_MAX,
  DESCRIPTION_BODY_M_BULLET_MIN,
  DESCRIPTION_BODY_M_MAX_FILES,
  DESCRIPTION_BODY_M_MAX_LINE_CHANGES,
  DESCRIPTION_BODY_M_MAX_WORDS_PER_BULLET,
  DESCRIPTION_BODY_S_BULLET_MAX,
  DESCRIPTION_BODY_S_BULLET_MIN,
  DESCRIPTION_BODY_S_MAX_WORDS_PER_BULLET,
  DESCRIPTION_MAP_MAX_ENTRIES,
  DESCRIPTION_MAP_OMIT_MAX_FILES,
  DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES,
} from "../../settings/index.ts";
import type { DescriptionPayload } from "./descriptionSchema.ts";

export type DescriptionMapMode = "omit" | "read_first";

export type DescriptionBodyScale = "S" | "M" | "L";

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
  S: {
    bulletMin: DESCRIPTION_BODY_S_BULLET_MIN,
    bulletMax: DESCRIPTION_BODY_S_BULLET_MAX,
    maxWordsPerBullet: DESCRIPTION_BODY_S_MAX_WORDS_PER_BULLET,
    technicalDepth: "what_why",
  },
  M: {
    bulletMin: DESCRIPTION_BODY_M_BULLET_MIN,
    bulletMax: DESCRIPTION_BODY_M_BULLET_MAX,
    maxWordsPerBullet: DESCRIPTION_BODY_M_MAX_WORDS_PER_BULLET,
    technicalDepth: "what_why_risk",
  },
  L: {
    bulletMin: DESCRIPTION_BODY_L_BULLET_MIN,
    bulletMax: DESCRIPTION_BODY_L_BULLET_MAX,
    maxWordsPerBullet: DESCRIPTION_BODY_L_MAX_WORDS_PER_BULLET,
    technicalDepth: "what_why_how",
  },
};

export function resolveDescriptionBodyScale(input: DescriptionSizeInput) {
  if (input.truncated) return ((pinnedReturn: DescriptionBodyScale) => pinnedReturn)("L");
  if (
    input.fileCount <= DESCRIPTION_MAP_OMIT_MAX_FILES &&
    input.totalChanges < DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES
  ) {
    return ((pinnedReturn: DescriptionBodyScale) => pinnedReturn)("S");
  }
  if (
    input.fileCount <= DESCRIPTION_BODY_M_MAX_FILES &&
    input.totalChanges < DESCRIPTION_BODY_M_MAX_LINE_CHANGES
  ) {
    return ((pinnedReturn: DescriptionBodyScale) => pinnedReturn)("M");
  }
  return ((pinnedReturn: DescriptionBodyScale) => pinnedReturn)("L");
}

function mapModeForBodyScale(bodyScale: DescriptionBodyScale) {
  return ((pinnedReturn: DescriptionMapMode) => pinnedReturn)(
    bodyScale === "S" ? "omit" : "read_first",
  );
}

export function resolveDescriptionWritingPolicy(input: DescriptionSizeInput) {
  const bodyScale = resolveDescriptionBodyScale(input);
  const mapMode = mapModeForBodyScale(bodyScale);
  const spec = BODY_SCALE_SPEC[bodyScale];
  return ((pinnedReturn: DescriptionWritingPolicy) => pinnedReturn)({
    mapMode,
    bodyScale,
    bulletMin: spec.bulletMin,
    bulletMax: spec.bulletMax,
    maxWordsPerBullet: spec.maxWordsPerBullet,
    technicalDepth: spec.technicalDepth,
  });
}

export type EnforceDescriptionMapOptions = {
  readonly maxEntries?: number;
  readonly knownPaths?: ReadonlySet<string>;
};

export function enforceDescriptionMapPayload(
  payload: DescriptionPayload,
  mode: DescriptionMapMode,
  opts: EnforceDescriptionMapOptions = {},
) {
  const maxEntries = opts.maxEntries ?? DESCRIPTION_MAP_MAX_ENTRIES;

  if (mode === "omit") {
    const strippedCount = payload.prFiles?.length ?? 0;
    if (strippedCount === 0) {
      return ((pinnedReturn: {
        payload: DescriptionPayload;
        strippedCount: number;
        cappedFrom?: number;
      }) => pinnedReturn)({ payload, strippedCount: 0 });
    }
    const { prFiles: _removed, ...rest } = payload;
    return ((pinnedReturn: {
      payload: DescriptionPayload;
      strippedCount: number;
      cappedFrom?: number;
    }) => pinnedReturn)({ payload: rest, strippedCount });
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
    return ((pinnedReturn: {
      payload: DescriptionPayload;
      strippedCount: number;
      cappedFrom?: number;
    }) => pinnedReturn)({ payload: rest, strippedCount: 0, cappedFrom });
  }

  return ((pinnedReturn: {
    payload: DescriptionPayload;
    strippedCount: number;
    cappedFrom?: number;
  }) => pinnedReturn)({
    payload: { ...payload, prFiles: files },
    strippedCount: 0,
    cappedFrom,
  });
}
