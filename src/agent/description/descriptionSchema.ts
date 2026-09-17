import * as v from "valibot";
import { fixDoubleEscapedString } from "../tools/fixDoubleEscapedString.js";
import { MAX_DESCRIPTION_PAYLOAD_PR_FILES } from "../../settings/index.js";

const descriptionPrTypeSchema = v.picklist([
  "Bug fix",
  "Tests",
  "Enhancement",
  "Documentation",
  "Other",
]);

const descriptionVisualKindSchema = v.picklist([
  "pseudocode",
  "call_tree",
  "component_tree",
  "file_tree",
  "mermaid",
  "diff",
  "full_block",
]);

const descriptionVisualLanguageSchema = v.picklist(["text", "tsx", "ts", "diff", "mermaid"]);

const descriptionVisualSchema = v.object({
  kind: descriptionVisualKindSchema,
  language: v.optional(descriptionVisualLanguageSchema),
  content: v.pipe(v.string(), v.minLength(1)),
});

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
  visuals: v.optional(v.array(descriptionVisualSchema)),
  prFiles: v.optional(
    v.pipe(v.array(descriptionFileSchema), v.maxLength(MAX_DESCRIPTION_PAYLOAD_PR_FILES)),
  ),
});

export type DescriptionVisualKind = v.InferOutput<typeof descriptionVisualKindSchema>;
export type DescriptionVisual = v.InferOutput<typeof descriptionVisualSchema>;
export type DescriptionPayload = v.InferOutput<typeof descriptionPayloadSchema>;
export type DescriptionPrFile = v.InferOutput<typeof descriptionFileSchema>;

/** Shape-only example for tool/repair prompts. Active map hard rule decides `prFiles`. */
export const DESCRIPTION_PAYLOAD_BASE_EXAMPLE: DescriptionPayload = {
  title: "Add user session validation",
  type: ["Enhancement"],
  description:
    "- The change validates the user session on each request.\n- It adds a middleware hook at the auth boundary.",
  visuals: [
    {
      kind: "call_tree",
      content: "handleRequest\n  validateSession\n  next",
    },
  ],
};

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = fixDoubleEscapedString(value).text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
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

const PR_TYPE_ALIASES: Record<string, v.InferOutput<typeof descriptionPrTypeSchema>> = {
  bug_fix: "Bug fix",
  bugfix: "Bug fix",
  "bug fix": "Bug fix",
  tests: "Tests",
  test: "Tests",
  enhancement: "Enhancement",
  documentation: "Documentation",
  docs: "Documentation",
  other: "Other",
};

function coercePrTypes(
  value: unknown,
): v.InferOutput<typeof descriptionPrTypeSchema>[] | undefined {
  const raw = coerceStringArray(value);
  if (!raw) return undefined;
  const mapped = raw.flatMap((item) => {
    const key = item.toLowerCase().replace(/\s+/g, " ");
    const alias = PR_TYPE_ALIASES[key.replace(/ /g, "_")] ?? PR_TYPE_ALIASES[key];
    if (alias) return [alias];
    const match = v.safeParse(descriptionPrTypeSchema, item);
    return match.success ? [match.output] : [];
  });
  return mapped.length > 0 ? [...new Set(mapped)] : undefined;
}

function coerceVisuals(value: unknown): DescriptionVisual[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const visuals = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const kind = trimString(row.kind);
    const content = trimString(row.content);
    if (!kind || !content) return [];
    const match = v.safeParse(descriptionVisualKindSchema, kind);
    if (!match.success) return [];
    const languageRaw = trimString(row.language);
    const languageMatch = languageRaw
      ? v.safeParse(descriptionVisualLanguageSchema, languageRaw)
      : null;
    return [
      {
        kind: match.output,
        content,
        ...(languageMatch?.success ? { language: languageMatch.output } : {}),
      },
    ];
  });
  return visuals.length > 0 ? visuals : undefined;
}

function coercePrFiles(value: unknown): DescriptionPrFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const filename = trimString(row.filename ?? row.file);
    const changesTitle = trimString(row.changesTitle ?? row.changes_title ?? row.reason);
    if (!filename || !changesTitle) return [];
    const changesSummary = trimString(row.changesSummary ?? row.changes_summary);
    const label = trimString(row.label);
    return [
      {
        filename,
        changesTitle,
        ...(changesSummary ? { changesSummary } : {}),
        ...(label ? { label } : {}),
      },
    ];
  });
  return files.length > 0 ? files : undefined;
}

export function coerceDescriptionPayloadInput(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const envelopeKeys = ["description", "describe", "payload", "result"];
  let source = raw;
  for (const key of envelopeKeys) {
    const nested = raw[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      source = nested as Record<string, unknown>;
      break;
    }
  }

  const coerced: Record<string, unknown> = { ...source };
  if (coerced.pr_files != null && coerced.prFiles == null) {
    coerced.prFiles = coerced.pr_files;
  }
  const title = trimString(coerced.title);
  if (title) coerced.title = title;
  const description = trimString(coerced.description);
  if (description) coerced.description = description;
  const types = coercePrTypes(coerced.type);
  if (types) coerced.type = types;
  const visuals = coerceVisuals(coerced.visuals);
  if (visuals) coerced.visuals = visuals;
  const prFiles = coercePrFiles(coerced.prFiles);
  if (prFiles) coerced.prFiles = prFiles;
  return coerced;
}
