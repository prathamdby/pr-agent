import {
  DESCRIPTION_MAP_MAX_ENTRIES,
  DESCRIPTION_MAP_OMIT_MAX_FILES,
  DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES,
} from "../../settings/index.js";
import type { DescriptionPayload } from "./descriptionSchema.js";

export type DescriptionMapMode = "omit" | "read_first";

export type DescriptionMapModeInput = {
  readonly fileCount: number;
  readonly totalChanges: number;
  readonly truncated: boolean;
};

export function resolveDescriptionMapMode(input: DescriptionMapModeInput): DescriptionMapMode {
  if (input.truncated) return "read_first";
  if (
    input.fileCount <= DESCRIPTION_MAP_OMIT_MAX_FILES &&
    input.totalChanges < DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES
  ) {
    return "omit";
  }
  return "read_first";
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
  if (opts.knownPaths && opts.knownPaths.size > 0) {
    files = files.filter((file) => opts.knownPaths!.has(file.filename));
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
