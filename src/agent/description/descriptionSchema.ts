import * as v from "valibot";
import { fixDoubleEscapedString } from "../tools/fixDoubleEscapedString.js";
import { MAX_DESCRIPTION_PAYLOAD_PR_FILES } from "../../settings/index.js";
import {
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "../../util/jsonValue.js";

const descriptionPrTypeSchema = v.picklist([
  "Bug fix",
  "Tests",
  "Enhancement",
  "Documentation",
  "Other",
]);

const descriptionFileSchema = v.object({
  filename: v.pipe(v.string(), v.minLength(1)),
  changesTitle: v.pipe(v.string(), v.minLength(1)),
  changesSummary: v.optional(v.string()),
  label: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export const descriptionPayloadSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  type: v.pipe(v.array(descriptionPrTypeSchema), v.minLength(1)),
  description: v.pipe(v.string(), v.minLength(1)),
  changesDiagram: v.optional(v.string()),
  prFiles: v.optional(
    v.pipe(v.array(descriptionFileSchema), v.maxLength(MAX_DESCRIPTION_PAYLOAD_PR_FILES)),
  ),
});

export type DescriptionPayload = v.InferOutput<typeof descriptionPayloadSchema>;
export type DescriptionPrFile = v.InferOutput<typeof descriptionFileSchema>;

export const DESCRIPTION_PAYLOAD_MINIMAL_EXAMPLE: DescriptionPayload = {
  title: "Add user session validation",
  type: ["Enhancement"],
  description:
    "- The change validates the user session on each request.\n- It adds a middleware hook at the auth boundary.",
  prFiles: [
    {
      filename: "src/auth/session.ts",
      changesTitle: "Auth boundary is the highest-risk surface in this PR",
    },
  ],
};

function trimString(value: JsonValue | undefined): string | undefined {
  if (value === undefined || !isJsonString(value)) return undefined;
  const trimmed = fixDoubleEscapedString(value).text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceStringArray(value: JsonValue | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => {
      const s = trimString(item);
      return s ? [s] : [];
    });
    return items.length > 0 ? items : undefined;
  }
  const single = trimString(value);
  if (!single) return undefined;
  return single
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type DescriptionPrType = v.InferOutput<typeof descriptionPrTypeSchema>;

function coercePrTypeToken(item: string): DescriptionPrType | undefined {
  const key = item.toLowerCase().replace(/\s+/g, " ");
  switch (key.replace(/ /g, "_")) {
    case "bug_fix":
    case "bugfix":
      return "Bug fix";
    case "tests":
    case "test":
      return "Tests";
    case "enhancement":
      return "Enhancement";
    case "documentation":
    case "docs":
      return "Documentation";
    case "other":
      return "Other";
    default: {
      const match = v.safeParse(descriptionPrTypeSchema, item);
      return match.success ? match.output : undefined;
    }
  }
}

function coercePrTypes(value: JsonValue | undefined): DescriptionPrType[] | undefined {
  const raw = coerceStringArray(value);
  if (!raw) return undefined;
  const mapped = raw.flatMap((item) => {
    const alias = coercePrTypeToken(item);
    return alias ? [alias] : [];
  });
  return mapped.length > 0 ? [...new Set(mapped)] : undefined;
}

function coercePrFiles(value: JsonValue | undefined): DescriptionPrFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: DescriptionPrFile[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) continue;
    const filename = trimString(item.filename ?? item.file);
    const changesTitle = trimString(item.changesTitle ?? item.changes_title ?? item.reason);
    if (!filename || !changesTitle) continue;
    const file: DescriptionPrFile = { filename, changesTitle };
    const changesSummary = trimString(item.changesSummary ?? item.changes_summary);
    if (changesSummary) file.changesSummary = changesSummary;
    const label = trimString(item.label);
    if (label) file.label = label;
    files.push(file);
  }
  return files.length > 0 ? files : undefined;
}

export function coerceDescriptionPayloadInput(raw: JsonObject): JsonObject {
  const envelopeKeys = ["description", "describe", "payload", "result"];
  let source: JsonObject = raw;
  for (const key of envelopeKeys) {
    const nested = raw[key];
    if (nested !== undefined && isJsonObject(nested)) {
      source = nested;
      break;
    }
  }

  const coerced = { ...source };
  if (coerced.changes_diagram != null && coerced.changesDiagram == null) {
    coerced.changesDiagram = coerced.changes_diagram;
  }
  if (coerced.pr_files != null && coerced.prFiles == null) {
    coerced.prFiles = coerced.pr_files;
  }
  const title = trimString(coerced.title);
  if (title) coerced.title = title;
  const description = trimString(coerced.description);
  if (description) coerced.description = description;
  const diagram = trimString(coerced.changesDiagram);
  if (diagram) coerced.changesDiagram = diagram;
  const types = coercePrTypes(coerced.type);
  if (types) coerced.type = types;
  const prFiles = coercePrFiles(coerced.prFiles);
  if (prFiles) coerced.prFiles = prFiles;
  return coerced;
}
