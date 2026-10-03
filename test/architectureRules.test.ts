import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportedSignatureTexts,
  forbiddenExportedParam,
  hasForbiddenImportReference,
  hasValueImportReference,
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
    id: "pi-sdk-under-runtime-only",
    forbiddenImports: ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"],
    allowedImporters: ["src/agent/runtime/**"],
  },
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
    id: "review-summary-comment-single-writer",
    pattern: /\.upsertProgressComment\(/,
    allowedPaths: [
      "src/review/publish/reviewSummaryComment.ts",
      "src/agent/triage/publishTriage.ts",
    ],
  },
  {
    id: "process-env-allowlist",
    pattern: /\bprocess\.env\b/,
    allowedPaths: [
      "src/settings/envReaders.ts",
      "src/evlog.ts",
      "src/agent/runtime/modelsJsonCatalog.ts",
      "src/github/appAuth.ts",
      "src/github/installationToken.ts",
      "src/prWorkspace/repositoryReader.ts",
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

function checkImportRule(rule: ImportRule): string[] {
  const violations: string[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = relative(process.cwd(), file);
    if (isAllowedImporter(rel, rule.allowedImporters)) continue;
    const text = readFileSync(file, "utf8");
    for (const forbidden of rule.forbiddenImports) {
      if (forbidden === "@octokit") {
        if (hasForbiddenImportReference(text, "@octokit")) violations.push(`${rule.id}: ${rel}`);
      } else if (
        forbidden.startsWith("@earendil-works/")
          ? /\b(?:from|import)\s*(?:\(\s*)?["']@earendil-works\//.test(
              text.replace(/^import\s+type\b[^;]*;/gm, ""),
            )
          : hasValueImportReference(text, forbidden)
      ) {
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

function runtimeImportGraph(entry: string, options: { staticOnly?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    // Type-only imports carry no runtime edge; strip them before edge matching.
    // Order matters: the two-line `import type {` ... `} from "..."` form first,
    // then remaining single-line `import type ...` forms.
    const stripped = text
      .replace(/^import\s+type\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/gm, "")
      .replace(/^import\s+type\s+[^\n]+$/gm, "");
    for (const match of stripped.matchAll(
      /(?:\bfrom\s+["'](\.[^"']+)["']|\bimport\s*\(\s*["'](\.[^"']+)["']\s*\))/g,
    )) {
      if (options.staticOnly && match[1] == null) continue;
      let spec = match[1] ?? match[2];
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

  it("catches pg/pg-boss value imports in any layout, including multiline", () => {
    expect(hasValueImportReference(`import { Pool } from "pg";`, "pg-value")).toBe(true);
    expect(hasValueImportReference(`import {\n  Pool\n} from "pg";`, "pg-value")).toBe(true);
    expect(hasValueImportReference(`export { Pool } from "pg";`, "pg-value")).toBe(true);
    expect(hasValueImportReference(`const p = await import("pg");`, "pg-value")).toBe(true);
    expect(hasValueImportReference(`import type { Pool } from "pg";`, "pg-value")).toBe(false);
    expect(hasValueImportReference(`export type { Pool } from "pg";`, "pg-value")).toBe(false);
    expect(hasValueImportReference(`// import { Pool } from "pg";\nconst x = 1;`, "pg-value")).toBe(
      false,
    );
  });

  it("keeps webhook server free of worker executors and orchestrator", () => {
    const graph = runtimeImportGraph("src/effect/server.ts");
    expect(graph.size).toBeLessThan(120);
    expect(graph.has("src/agentWork/runtime.ts")).toBe(true);
    expect(graph.has("src/agentWork/intake/delivery.ts")).toBe(true);
    expect(graph.has("src/webhook/intakeCommand.ts")).toBe(true);
    expect(graph.has("src/effect/services/webhookHandlers.ts")).toBe(false);
    expect(graph.has("src/agentWork/worker.ts")).toBe(false);
    expect(graph.has("src/agentWork/executors/reviewExecutor.ts")).toBe(false);
    expect(graph.has("src/review/orchestrator/orchestratorRun.ts")).toBe(false);
    expect(graph.has("src/agent/runtime/piSession.ts")).toBe(false);
    // loadConfig reaches the Pi catalog through a worker-only dynamic import.
    expect(runtimeImportGraph("src/effect/server.ts", { staticOnly: true })).not.toContain(
      "src/agent/runtime/modelsJson.ts",
    );
  });
});
