import path from "node:path";

export type PreflightFileEntry = {
  readonly filename: string;
};

export type TrivialChangeGateInput = {
  readonly files: readonly PreflightFileEntry[];
  readonly truncated: boolean;
};

export type TrivialChangeGateResult =
  | { readonly exempt: true }
  | {
      readonly exempt: false;
      readonly reason: "truncated" | "empty" | "not_docs_only";
    };

const ROOT_DOC_STEM = /^(readme|license|changelog)$/i;
const DOCS_DIR_EXTENSIONS = new Set([".md", ".mdx"]);

function isDocsDirPath(filename: string, base: string) {
  if (!filename.toLowerCase().startsWith("docs/"))
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    DOCS_DIR_EXTENSIONS.has(path.extname(base).toLowerCase()),
  );
}

function isRootDocBasename(base: string) {
  const ext = path.extname(base).toLowerCase();
  if (ext !== "" && ext !== ".md") return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  return ((pinnedReturn: boolean) => pinnedReturn)(ROOT_DOC_STEM.test(stem));
}

export function isDocsOnlyPath(filename: string) {
  const base = path.basename(filename);
  const lower = filename.toLowerCase();

  if (isDocsDirPath(filename, base)) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  if (isRootDocBasename(base)) return ((pinnedReturn: boolean) => pinnedReturn)(true);
  if (lower.startsWith(".github/") && lower.endsWith(".md"))
    return ((pinnedReturn: boolean) => pinnedReturn)(true);

  return ((pinnedReturn: boolean) => pinnedReturn)(false);
}

export function evaluateTrivialChangeExemption(input: TrivialChangeGateInput) {
  if (input.truncated) {
    return ((pinnedReturn: TrivialChangeGateResult) => pinnedReturn)({
      exempt: false,
      reason: "truncated",
    });
  }
  if (input.files.length === 0) {
    return ((pinnedReturn: TrivialChangeGateResult) => pinnedReturn)({
      exempt: false,
      reason: "empty",
    });
  }
  for (const file of input.files) {
    if (!isDocsOnlyPath(file.filename)) {
      return ((pinnedReturn: TrivialChangeGateResult) => pinnedReturn)({
        exempt: false,
        reason: "not_docs_only",
      });
    }
  }
  return ((pinnedReturn: TrivialChangeGateResult) => pinnedReturn)({ exempt: true as const });
}
