import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportedSignatureTexts,
  forbiddenExportedParam,
  hasForbiddenImportReference,
} from "./architectureRulesHelpers.js";

const SRC_ROOT = join(process.cwd(), "src");

export type ImportRule = {
  id: string;
  forbiddenImports: string[];
  allowedImporters: string[];
};

export type SourceRule = {
  id: string;
  pattern: RegExp;
  allowedPaths: string[];
};

const IMPORT_RULES: ImportRule[] = [
  {
    id: "octokit-under-github-only",
    forbiddenImports: ["@octokit"],
    allowedImporters: ["src/github/**"],
  },
  {
    id: "pg-value-under-db-or-boss-only",
    forbiddenImports: ["pg-value", "pg-boss-value"],
    allowedImporters: ["src/db/**", "src/agentWork/boss.ts"],
  },
];

const SOURCE_RULES: SourceRule[] = [
  {
    id: "process-env-allowlist",
    pattern: /\bprocess\.env\b/,
    allowedPaths: [
      "src/config.ts",
      "src/evlog.ts",
      "src/settings/modelsJsonCatalog.ts",
      "src/settings/codeModeConstants.ts",
      "src/github/appAuth.ts",
      "src/github/installationToken.ts",
      "src/prWorkspace/localPrWorkspace.ts",
      "src/prWorkspace/writablePrCheckout.ts",
      "src/agent/triage/triageWorkspaceTools.ts",
      "src/agentWork/durableJob.ts",
    ],
  },
];

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function isAllowedImporter(rel: string, allowed: string[]): boolean {
  return allowed.some((pattern) =>
    pattern.endsWith("/**") ? rel.startsWith(pattern.slice(0, -3)) : rel === pattern,
  );
}

/** Value (non-`import type`) references to pg / pg-boss only. */
function hasValueImportReference(text: string, module: string): boolean {
  const lines = text.split("\n");
  const valueLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import")) return false;
    if (/^import\s+type\b/.test(trimmed)) return false;
    return true;
  });
  const joined = valueLines.join("\n");
  if (module === "pg-value") return /\bfrom\s+["']pg["']/.test(joined);
  return /\bfrom\s+["']pg-boss["']/.test(joined);
}

function checkImportRule(rule: ImportRule): string[] {
  const violations: string[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = relative(process.cwd(), file);
    if (isAllowedImporter(rel, rule.allowedImporters)) continue;
    const text = readFileSync(file, "utf8");
    for (const forbidden of rule.forbiddenImports) {
      if (forbidden === "@octokit") {
        if (hasForbiddenImportReference(text, "@octokit")) violations.push(`${rule.id}: ${rel}`);
      } else if (hasValueImportReference(text, forbidden)) {
        violations.push(`${rule.id}: ${rel}`);
      }
    }
  }
  return violations;
}

function checkSourceRule(rule: SourceRule): string[] {
  const allowed = new Set(rule.allowedPaths);
  const violations: string[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = relative(process.cwd(), file);
    if (allowed.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (rule.pattern.test(text)) violations.push(`${rule.id}: ${rel}`);
  }
  return violations;
}

function runtimeImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const stripped = text
      .replace(/^import\s+type\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
      .replace(/^import\s+type\s+[^;]+;?\s*$/gm, "");
    for (const match of stripped.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      let spec = match[1]!;
      if (spec.endsWith(".js")) spec = `${spec.slice(0, -3)}.ts`;
      else if (!spec.endsWith(".ts")) spec = `${spec}.ts`;
      const resolved = relative(process.cwd(), join(file, "..", spec)).replace(/\\/g, "/");
      const normalized = resolved.startsWith("src/")
        ? resolved
        : `src/${resolved.split("src/").pop()}`;
      if (!seen.has(normalized) && existsSync(join(process.cwd(), normalized)))
        queue.push(normalized);
    }
  }
  return seen;
}

describe("architecture rules", () => {
  it("keeps banned imports inside their seams (ADR 0026 and boundary rows)", () => {
    const violations = IMPORT_RULES.flatMap(checkImportRule);
    expect(violations).toEqual([]);
  });

  it("keeps process.env reads inside the allowlist", () => {
    const violations = SOURCE_RULES.flatMap(checkSourceRule);
    expect(violations).toEqual([]);
  });

  it("does not export installation-token parameters outside src/github/", () => {
    const violations: Array<{ file: string; line: string; reason: string }> = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(process.cwd(), file);
      if (rel.startsWith("src/github/") || rel.startsWith("src/prWorkspace/")) continue;
      const text = readFileSync(file, "utf8");
      for (const signature of exportedSignatureTexts(text)) {
        const reason = forbiddenExportedParam(signature);
        if (reason != null) violations.push({ file: rel, line: signature, reason });
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps webhook server free of worker executors and orchestrator", () => {
    const graph = runtimeImportGraph("src/effect/server.ts");
    expect(graph.size).toBeLessThan(120);
    expect(graph.has("src/agentWork/runtime.ts")).toBe(true);
    expect(graph.has("src/agentWork/worker.ts")).toBe(false);
    expect(graph.has("src/agentWork/executors/reviewExecutor.ts")).toBe(false);
    expect(graph.has("src/review/orchestrator/orchestratorRun.ts")).toBe(false);
    expect(graph.has("src/agent/runtime/piSession.ts")).toBe(false);
    expect(graph.has("src/settings/modelsJson.ts")).toBe(false);
  });
});
