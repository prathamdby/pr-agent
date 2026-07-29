import { describe, expect, it } from "vitest";
import {
  enforceDescriptionMapPayload,
  resolveDescriptionMapMode,
} from "../src/agent/description/descriptionMapMode.js";
import type { DescriptionPayload } from "../src/agent/description/descriptionSchema.js";
import {
  DESCRIPTION_MAP_MAX_ENTRIES,
  DESCRIPTION_MAP_OMIT_MAX_FILES,
  DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES,
} from "../src/settings/index.js";

const basePayload = (prFiles?: DescriptionPayload["prFiles"]): DescriptionPayload => ({
  title: "t",
  type: ["Enhancement"],
  description: "- Main",
  ...(prFiles ? { prFiles } : {}),
});

const mapEntry = (filename: string) => ({
  filename,
  changesTitle: `Open ${filename} first`,
});

describe("resolveDescriptionMapMode", () => {
  it("omits when file count and line changes are under thresholds and not truncated", () => {
    expect(
      resolveDescriptionMapMode({
        fileCount: DESCRIPTION_MAP_OMIT_MAX_FILES,
        totalChanges: DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES - 1,
        truncated: false,
      }),
    ).toBe("omit");
  });

  it("omits for zero files", () => {
    expect(
      resolveDescriptionMapMode({ fileCount: 0, totalChanges: 0, truncated: false }),
    ).toBe("omit");
  });

  it("uses read_first when file count exceeds omit max", () => {
    expect(
      resolveDescriptionMapMode({
        fileCount: DESCRIPTION_MAP_OMIT_MAX_FILES + 1,
        totalChanges: 10,
        truncated: false,
      }),
    ).toBe("read_first");
  });

  it("uses read_first when totalChanges is at or above omit max", () => {
    expect(
      resolveDescriptionMapMode({
        fileCount: 1,
        totalChanges: DESCRIPTION_MAP_OMIT_MAX_LINE_CHANGES,
        truncated: false,
      }),
    ).toBe("read_first");
  });

  it("uses read_first when truncated even if small", () => {
    expect(
      resolveDescriptionMapMode({
        fileCount: 1,
        totalChanges: 1,
        truncated: true,
      }),
    ).toBe("read_first");
  });

  it("uses read_first for many files with tiny line changes", () => {
    expect(
      resolveDescriptionMapMode({
        fileCount: 20,
        totalChanges: 5,
        truncated: false,
      }),
    ).toBe("read_first");
  });

  it("uses read_first for few files with huge line changes", () => {
    expect(
      resolveDescriptionMapMode({
        fileCount: 1,
        totalChanges: 5000,
        truncated: false,
      }),
    ).toBe("read_first");
  });
});

describe("enforceDescriptionMapPayload", () => {
  it("strips prFiles on omit mode", () => {
    const payload = basePayload([mapEntry("src/a.ts"), mapEntry("src/b.ts")]);
    const result = enforceDescriptionMapPayload(payload, "omit");
    expect(result.strippedCount).toBe(2);
    expect(result.payload.prFiles).toBeUndefined();
  });

  it("leaves payload unchanged on omit when prFiles absent", () => {
    const payload = basePayload();
    const result = enforceDescriptionMapPayload(payload, "omit");
    expect(result.strippedCount).toBe(0);
    expect(result.payload).toEqual(payload);
  });

  it("caps read_first entries at DESCRIPTION_MAP_MAX_ENTRIES", () => {
    const files = Array.from({ length: DESCRIPTION_MAP_MAX_ENTRIES + 3 }, (_, i) =>
      mapEntry(`src/f${i}.ts`),
    );
    const result = enforceDescriptionMapPayload(basePayload(files), "read_first");
    expect(result.payload.prFiles).toHaveLength(DESCRIPTION_MAP_MAX_ENTRIES);
    expect(result.cappedFrom).toBe(DESCRIPTION_MAP_MAX_ENTRIES + 3);
  });

  it("drops paths not in knownPaths on read_first", () => {
    const result = enforceDescriptionMapPayload(
      basePayload([mapEntry("src/real.ts"), mapEntry("src/fake.ts")]),
      "read_first",
      { knownPaths: new Set(["src/real.ts"]) },
    );
    expect(result.payload.prFiles).toEqual([mapEntry("src/real.ts")]);
  });
});
