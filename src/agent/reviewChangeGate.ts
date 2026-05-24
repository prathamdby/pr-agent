/** Docs-only trivial change exemption for automated reviews. */

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
  | { readonly exempt: false; readonly reason: "truncated" | "empty" | "not_docs_only" };

const ROOT_DOC_STEM = /^(readme|license|changelog)$/i;

function isRootDocBasename(base: string): boolean {
  const ext = path.extname(base).toLowerCase();
  if (ext !== "" && ext !== ".md") return false;
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  return ROOT_DOC_STEM.test(stem);
}

/** Strict docs-only allowlist per ADR 0014. */
export function isDocsOnlyPath(filename: string): boolean {
  const base = path.basename(filename);
  const lower = filename.toLowerCase();

  if (lower.endsWith(".md")) return true;
  if (lower.startsWith("docs/")) return true;
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
