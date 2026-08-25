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

function isDocsDirPath(filename: string, base: string): boolean {
  if (!filename.toLowerCase().startsWith("docs/")) return false;
  return DOCS_DIR_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function isRootDocBasename(base: string): boolean {
  const ext = path.extname(base).toLowerCase();
  if (ext !== "" && ext !== ".md") return false;
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  return ROOT_DOC_STEM.test(stem);
}

/** Strict docs-only allowlist per ADR 0010. */
export function isDocsOnlyPath(filename: string): boolean {
  const base = path.basename(filename);
  const lower = filename.toLowerCase();

  if (isDocsDirPath(filename, base)) return true;
  if (isRootDocBasename(base)) return true;
  if (lower.startsWith(".github/") && lower.endsWith(".md")) return true;

  return false;
}

export function evaluateTrivialChangeExemption(
  input: TrivialChangeGateInput,
): TrivialChangeGateResult {
  if (input.truncated) {
    return { exempt: false, reason: "truncated" };
  }
  if (input.files.length === 0) {
    return { exempt: false, reason: "empty" };
  }
  for (const file of input.files) {
    if (!isDocsOnlyPath(file.filename)) {
      return { exempt: false, reason: "not_docs_only" };
    }
  }
  return { exempt: true as const };
}
