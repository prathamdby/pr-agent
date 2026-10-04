import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportedSignatureTexts,
  forbiddenExportedParam,
  isCodeRowAllowed,
  sourceMatchesCodeRow,
  type CodeRow,
} from "./architectureRulesHelpers.js";

const SRC_ROOT = join(process.cwd(), "src");

export type SourceRule = {
  id: string;
  pattern: RegExp;
  allowedPaths: string[];
};

const CODE_KINDS = new Set([
  "module",
  "identifier",
  "process-env",
  "escape-call",
  "sql-status",
  "console-call",
]);

function loadCodeRows(): CodeRow[] {
  const dir = join(process.cwd(), "scripts", "guards");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as CodeRow)
    .filter((row) => CODE_KINDS.has(row.kind));
}

const SOURCE_RULES: SourceRule[] = [
  {
    id: "review-summary-comment-single-writer",
    pattern: /\.upsertProgressComment\(/,
    allowedPaths: [
      "src/review/publish/reviewSummaryComment.ts",
      "src/agent/triage/publishTriage.ts",
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

function codeRowViolations(row: CodeRow): string[] {
  const violations: string[] = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = relative(process.cwd(), file);
    if (isCodeRowAllowed(rel, row.allow)) continue;
    const text = readFileSync(file, "utf8");
    if (sourceMatchesCodeRow(row, file, text)) violations.push(`${row.id}: ${rel}`);
  }
  return violations;
}

function legacyOctokit(text: string): boolean {
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return /\bfrom\s+["']@octokit\//.test(cleaned) || /\bimport\s+["']@octokit\//.test(cleaned);
}

function legacyValueImport(text: string, specifier: "pg" | "pg-boss"): boolean {
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const quoted = `["']${specifier}["']`;
  const clauses = cleaned.split(new RegExp(`\\bfrom\\s*${quoted}`));
  for (let i = 0; i < clauses.length - 1; i += 1) {
    const before = clauses.slice(0, i + 1).join(`from "${specifier}"`);
    const head = before.match(/[\s\S]*\b(import|export)\b([\s\S]*)$/);
    if (head == null) continue;
    if (!/^\s*type\b/.test(head[2])) return true;
  }
  return new RegExp(`\\bimport\\s*\\(\\s*${quoted}\\s*\\)`).test(cleaned);
}

function legacyPi(text: string): boolean {
  const stripped = text.replace(/^import\s+type\b[^;]*;/gm, "");
  return /\b(?:from|import)\s*(?:\(\s*)?["']@earendil-works\//.test(stripped);
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
  it("keeps code rows inside their allowlists and catches each snippet", () => {
    const rows = loadCodeRows();
    expect(rows.length).toBeGreaterThan(0);
    const violations = rows.flatMap(codeRowViolations);
    expect(violations).toEqual([]);
    for (const row of rows) {
      expect(row.mustCatch.length).toBeGreaterThan(0);
      for (const snippet of row.mustCatch) {
        expect([row.id, sourceMatchesCodeRow(row, "src/banned/probe.ts", snippet)]).toEqual([
          row.id,
          true,
        ]);
      }
    }
  });

  it("sees every legacy module hit the regex walker saw", () => {
    const rows = loadCodeRows();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const checks: Array<{ id: string; hit: (text: string) => boolean }> = [
      { id: "octokit", hit: legacyOctokit },
      { id: "pi-sdk", hit: legacyPi },
      { id: "pg", hit: (text) => legacyValueImport(text, "pg") },
      { id: "pg-boss", hit: (text) => legacyValueImport(text, "pg-boss") },
    ];
    const missed: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(process.cwd(), file);
      const text = readFileSync(file, "utf8");
      for (const check of checks) {
        const row = byId.get(check.id);
        if (row == null || isCodeRowAllowed(rel, row.allow)) continue;
        if (check.hit(text) && !sourceMatchesCodeRow(row, file, text))
          missed.push(`${check.id}: ${rel}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("keeps process.env reads inside the allowlist", () => {
    const violations = SOURCE_RULES.flatMap(checkSourceRule);
    expect(violations).toEqual([]);
  });

  it("flags multi-line exported token parameters", () => {
    const fixture = `
export function buildThing(
  owner: string,
  token: string,
): void {}
`;
    const signatures = exportedSignatureTexts(fixture);
    expect(signatures).toHaveLength(1);
    expect(forbiddenExportedParam(signatures[0])).toBe("token: string");
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

  it("does not let a type-only import hide the next value import", () => {
    const rows = loadCodeRows();
    const pg = rows.find((row) => row.id === "pg");
    expect(pg).toBeDefined();
    const text = 'import type { X } from "pg"\nimport { Pool } from "pg";';
    expect(sourceMatchesCodeRow(pg!, "src/banned/probe.ts", text)).toBe(true);
  });

  it("sees guards inside template interpolation", () => {
    const rows = loadCodeRows();
    const env = rows.find((row) => row.id === "process-env");
    expect(env).toBeDefined();
    expect(
      sourceMatchesCodeRow(env!, "src/banned/probe.ts", "const x = `a ${process.env.FOO}`;"),
    ).toBe(true);
  });

  it("matches status assignment only in the SET clause", () => {
    const rows = loadCodeRows();
    const sql = rows.find((row) => row.id === "sql-status");
    expect(sql).toBeDefined();
    const hit = "const q = `UPDATE agent_work_items SET\n  status = 'failed' WHERE id = $1`;";
    const miss =
      "const q = `UPDATE agent_work_items SET updated_at = now() WHERE status = 'failed'`;";
    expect(sourceMatchesCodeRow(sql!, "src/banned/probe.ts", hit)).toBe(true);
    expect(sourceMatchesCodeRow(sql!, "src/banned/probe.ts", miss)).toBe(false);
  });

  it("treats a trailing slash as a directory prefix", () => {
    expect(isCodeRowAllowed("src/github/foo.ts", ["src/github/"])).toBe(true);
    expect(isCodeRowAllowed("src/github-extra/foo.ts", ["src/github/"])).toBe(false);
    expect(isCodeRowAllowed("src/index.ts", ["src/index.ts"])).toBe(true);
    expect(isCodeRowAllowed("src/index.ts.bak", ["src/index.ts"])).toBe(false);
  });

  it("ignores type-only pg imports and comment-only seam names", () => {
    const rows = loadCodeRows();
    const pg = rows.find((row) => row.id === "pg");
    const octokit = rows.find((row) => row.id === "octokit");
    const ident = rows.find((row) => row.id === "installation-octokit");
    expect(pg).toBeDefined();
    expect(octokit).toBeDefined();
    expect(ident).toBeDefined();
    expect(
      sourceMatchesCodeRow(pg!, "src/banned/probe.ts", `import type { Pool } from "pg";`),
    ).toBe(false);
    const commented = `
// installationOctokit is only used under src/github/
const label = "installationOctokit";
import { foo } from "../agent/foo.js";
`;
    expect(sourceMatchesCodeRow(ident!, "src/banned/probe.ts", commented)).toBe(false);
    expect(
      sourceMatchesCodeRow(
        octokit!,
        "src/banned/probe.ts",
        `// import { Octokit } from "@octokit/rest";`,
      ),
    ).toBe(false);
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
