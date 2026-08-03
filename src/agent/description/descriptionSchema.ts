import { z } from "zod";
import { fixDoubleEscapedString } from "../tools/fixDoubleEscapedString.js";
import { MAX_DESCRIPTION_PAYLOAD_PR_FILES } from "../../settings/index.js";

const descriptionPrTypeSchema = z.enum([
  "Bug fix",
  "Tests",
  "Enhancement",
  "Documentation",
  "Other",
]);

const descriptionFileSchema = z.object({
  filename: z.string().min(1),
  changesTitle: z.string().min(1),
  changesSummary: z.string().optional(),
  label: z.string().min(1).optional(),
});

export const descriptionPayloadSchema = z.object({
  title: z.string().min(1),
  type: z.array(descriptionPrTypeSchema).min(1),
  description: z.string().min(1),
  changesDiagram: z.string().optional(),
  prFiles: z.array(descriptionFileSchema).max(MAX_DESCRIPTION_PAYLOAD_PR_FILES).optional(),
});

export type DescriptionPayload = z.infer<typeof descriptionPayloadSchema>;
export type DescriptionPrFile = z.infer<typeof descriptionFileSchema>;

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

const PR_TYPE_ALIASES: Record<string, z.infer<typeof descriptionPrTypeSchema>> = {
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

function coercePrTypes(value: unknown): z.infer<typeof descriptionPrTypeSchema>[] | undefined {
  const raw = coerceStringArray(value);
  if (!raw) return undefined;
  const mapped = raw.flatMap((item) => {
    const key = item.toLowerCase().replace(/\s+/g, " ");
    const alias = PR_TYPE_ALIASES[key.replace(/ /g, "_")] ?? PR_TYPE_ALIASES[key];
    if (alias) return [alias];
    const match = descriptionPrTypeSchema.safeParse(item);
    return match.success ? [match.data] : [];
  });
  return mapped.length > 0 ? [...new Set(mapped)] : undefined;
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
