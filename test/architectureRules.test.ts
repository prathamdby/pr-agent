import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  "call",
  "member-call",
  "optional-field",
  "fence-literal",
  "github-list",
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

type CommentLint = { lines: Record<string, number[]>; fixed: Record<string, string> };

type LintReport = {
  diagnostics: { code: string; filename: string; labels: { span: { line: number } }[] }[];
};

type PluginRuleConfig = { rules: Record<string, unknown> };

type PluginLint = {
  lines: (rule: string) => Record<string, number[]>;
  fixed: Record<string, string>;
};

function repoPluginRules(): PluginRuleConfig {
  const repoConfig: { rules?: Record<string, unknown> } = JSON.parse(
    readFileSync(join(process.cwd(), ".oxlintrc.json"), "utf8"),
  );
  return {
    rules: Object.fromEntries(
      Object.entries(repoConfig.rules ?? {}).filter(([name]) => name.startsWith("pr-agent/")),
    ),
  };
}

function lintWithPlugin(
  files: Record<string, string>,
  options: { fix?: boolean; config?: PluginRuleConfig } = {},
): PluginLint {
  const repoConfig: { jsPlugins?: string[] } = JSON.parse(
    readFileSync(join(process.cwd(), ".oxlintrc.json"), "utf8"),
  );
  const dir = mkdtempSync(join(tmpdir(), "pr-agent-lint-"));
  try {
    const config = {
      jsPlugins: (repoConfig.jsPlugins ?? []).map((entry) => resolve(process.cwd(), entry)),
      ...(options.config ?? repoPluginRules()),
    };
    const configPath = join(dir, "oxlintrc.json");
    writeFileSync(configPath, JSON.stringify(config));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let raw = "";
    try {
      raw = execFileSync(
        join(process.cwd(), "node_modules", ".bin", "oxlint"),
        ["--format", "json", "-c", configPath, ...(options.fix ? ["--fix"] : []), "."],
        { encoding: "utf8", cwd: dir },
      );
    } catch (error) {
      const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
      raw = typeof stdout === "string" ? stdout : "";
      if (!raw.trim().startsWith("{")) throw error;
    }
    const report: LintReport = JSON.parse(raw);
    const fixed = Object.fromEntries(
      Object.keys(files).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
    );
    const lines = (rule: string) => {
      const found: Record<string, number[]> = Object.fromEntries(
        Object.keys(files).map((name) => [name, []]),
      );
      for (const item of report.diagnostics) {
        if (item.code !== `pr-agent(${rule})`) continue;
        const name = item.filename.replace(/\\/g, "/");
        const list = Object.hasOwn(found, name) ? found[name] : undefined;
        if (!list) throw new Error(`lint diagnostic for unknown probe file: ${name}`);
        list.push(item.labels[0]?.span.line ?? 0);
      }
      for (const list of Object.values(found)) list.sort((a, b) => a - b);
      return found;
    };
    return { lines, fixed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lintComments(files: Record<string, string>, fix: boolean): CommentLint {
  const nested = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [`src/${name}`, text]),
  );
  const run = lintWithPlugin(nested, { fix });
  const flat = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(record).map(([name, value]) => [name.slice("src/".length), value]),
    );
  return { lines: flat(run.lines("no-comments")), fixed: flat(run.fixed) };
}

const suppression = (tool: "oxlint" | "eslint", rest: string) => `${tool}-disable${rest}`;

const VALID_SUPPRESSION = `// ${suppression("oxlint", "-next-line no-console -- Probe output.")}`;

const COMMENT_PROBE = [
  "// line",
  "/* block */",
  "/** jsdoc */",
  "export const a = 1; // trailing",
  `/* ${suppression("eslint", " no-console")} */`,
  `// ${suppression("eslint", "-next-line no-console")}`,
  `// ${suppression("oxlint", "-next-line no-console")}`,
  "// @ts-expect-error",
  'export const url = "https://example.com/* not a comment */";',
  "export const tpl = `// ${a} /* still text */`;",
  "export const re = /\\/\\*[^*]*\\//;",
  VALID_SUPPRESSION,
  "console.log(a);",
  '/// <reference types="node" />',
  "",
].join("\n");

const JSX_PROBE = "export const view = <div>{/* note */}</div>;\n";

const ASI_PROBE = "export function f() {\n  return /*\n  */ 1;\n}\n";

const PROMPT_LAYOUT_PROBE: Record<string, string> = {
  "src/prompts/policy/prompt.ts": "export const a = 1;\n",
  "src/prompts/ask/rules.ts": "export const a = 1;\n",
  "src/prompts/ask/prompt.tsx": "export const a = 1;\n",
  "src/prompts/ask/extra/prompt.ts": "export const a = 1;\n",
  "src/prompts/index.ts": "export const a = 1;\n",
  "src/prompts/shared/prompt.ts": "export const a = 1;\n",
  "src/prompts/ask/prompt.ts": "export const a = 1;\n",
  "src/prompts/security/examples.ts": "export const a = 1;\n",
  "src/prompts/shared/safety.ts": "export const a = 1;\n",
  "src/agent/rules.ts": "export const a = 1;\n",
};

const PROMPT_IMPORTS_PROBE: Record<string, string> = {
  "src/review/sectionImports.ts": [
    'import { a } from "../prompts/ask/behavior.js";',
    'export { b } from "../prompts/shared/context.js";',
    'export const c = () => import("../prompts/triage/output.js");',
    'import type { D } from "../prompts/shared/tools.js";',
    "export const e = [a];",
    "",
  ].join("\n"),
  "src/agent/entryImports.ts": [
    'import { askSystemPrompt } from "../prompts/ask/prompt.js";',
    'import { envelope } from "../prompts/shared/safety.js";',
    'import { a } from "./prompts/ask/behavior.js";',
    "export const e = [askSystemPrompt, envelope, a];",
    "",
  ].join("\n"),
  "src/prompts/ask/prompt.ts": [
    'import { loadRepoPolicy } from "../../review/repoPolicy.js";',
    'import { readFileSync } from "node:fs";',
    'import type { Config } from "../../settings/config.js";',
    'import { ASK_RETRY_NUDGE } from "../../settings/askConstants.js";',
    'import { MAX_TOOL_ROUNDS } from "../../settings/index.js";',
    'import { escape } from "../../util/escape.js";',
    'import { renderGuestCatalogue } from "../../agent/codemode/guestCatalogue.js";',
    'import { envelope } from "../shared/safety.js";',
    'import { askOutput } from "./output.js";',
    "export const e = [loadRepoPolicy, readFileSync, ASK_RETRY_NUDGE, MAX_TOOL_ROUNDS];",
    "export const f = [escape, renderGuestCatalogue, envelope, askOutput];",
    "export type G = Config;",
    "",
  ].join("\n"),
  "src/prompts/shared/context.ts": [
    'import { triageSystemPrompt } from "../triage/prompt.js";',
    'import type { AskInput } from "../ask/context.js";',
    'import { envelope } from "./safety.js";',
    "export const e = [triageSystemPrompt, envelope];",
    "export type F = AskInput;",
    "",
  ].join("\n"),
  "test/promptImports.ts": 'import { a } from "../src/prompts/ask/behavior.js";\nexport { a };\n',
};

describe("architecture rules", () => {
  it("keeps prompt modules at src/prompts/<shared|role>/<section|prompt>.ts", () => {
    expect(lintWithPlugin(PROMPT_LAYOUT_PROBE).lines("prompt-layout")).toEqual({
      "src/prompts/policy/prompt.ts": [1],
      "src/prompts/ask/rules.ts": [1],
      "src/prompts/ask/prompt.tsx": [1],
      "src/prompts/ask/extra/prompt.ts": [1],
      "src/prompts/index.ts": [1],
      "src/prompts/shared/prompt.ts": [1],
      "src/prompts/ask/prompt.ts": [],
      "src/prompts/security/examples.ts": [],
      "src/prompts/shared/safety.ts": [],
      "src/agent/rules.ts": [],
    });
  });

  it("limits import edges into, inside, and out of src/prompts/", () => {
    expect(lintWithPlugin(PROMPT_IMPORTS_PROBE).lines("prompt-imports")).toEqual({
      "src/review/sectionImports.ts": [1, 2, 3, 4],
      "src/agent/entryImports.ts": [],
      "src/prompts/ask/prompt.ts": [1, 2],
      "src/prompts/shared/context.ts": [1, 2],
      "test/promptImports.ts": [],
    });
  });

  it("reports prompt rules only when the config enables them", () => {
    const run = lintWithPlugin(
      { ...PROMPT_LAYOUT_PROBE, ...PROMPT_IMPORTS_PROBE },
      { config: { rules: { "pr-agent/prompt-imports": "error" } } },
    );
    expect(Object.values(run.lines("prompt-layout")).flat()).toEqual([]);
    expect(run.lines("prompt-imports")["src/prompts/shared/context.ts"]).toEqual([1, 2]);
  });

  it("reports every comment except the two machine directives", () => {
    const { lines } = lintComments(
      { "probe.ts": COMMENT_PROBE, "view.tsx": JSX_PROBE, "asi.mjs": ASI_PROBE },
      false,
    );
    expect(lines).toEqual({
      "probe.ts": [1, 2, 3, 4, 5, 6, 7, 8],
      "view.tsx": [1],
      "asi.mjs": [2],
    });
  });

  it("removes comments without changing behaviour or the machine directives", async () => {
    const { fixed } = lintComments(
      { "probe.ts": COMMENT_PROBE, "view.tsx": JSX_PROBE, "asi.mjs": ASI_PROBE },
      true,
    );
    expect(lintComments(fixed, false).lines).toEqual({
      "probe.ts": [],
      "view.tsx": [],
      "asi.mjs": [],
    });
    expect(fixed["probe.ts"]).not.toMatch(/\/\/ (line|trailing|eslint|@ts)|\/\*\*? (block|jsdoc)/);
    expect(fixed["probe.ts"]).toContain(VALID_SUPPRESSION);
    expect(fixed["probe.ts"]).toContain('/// <reference types="node" />');
    expect(fixed["probe.ts"]).toContain("https://example.com/* not a comment */");
    expect(fixed["view.tsx"]).toBe("export const view = <div></div>;\n");
    const dir = mkdtempSync(join(tmpdir(), "no-comments-asi-"));
    try {
      const file = join(dir, "asi.mjs");
      writeFileSync(file, fixed["asi.mjs"] ?? "");
      const loaded: { f: () => unknown } = await import(pathToFileURL(file).href);
      expect(loaded.f()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    expect(runtimeImportGraph("src/effect/server.ts", { staticOnly: true })).not.toContain(
      "src/agent/runtime/modelsJson.ts",
    );
  });
});
