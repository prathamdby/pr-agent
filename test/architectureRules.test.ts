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

type PluginRuleConfig = {
  rules: Record<string, unknown>;
  overrides?: { files: string[]; rules: Record<string, unknown> }[];
};

type PluginLint = {
  lines: (rule: string) => Record<string, number[]>;
  fixed: Record<string, string>;
};

function repoPluginRules(): PluginRuleConfig {
  const repoConfig: PluginRuleConfig = JSON.parse(
    readFileSync(join(process.cwd(), ".oxlintrc.json"), "utf8"),
  );
  return {
    rules: Object.fromEntries(
      Object.entries(repoConfig.rules ?? {}).filter(([name]) => name.startsWith("pr-agent/")),
    ),
    overrides: (repoConfig.overrides ?? [])
      .map((override) => ({
        files: override.files,
        rules: Object.fromEntries(
          Object.entries(override.rules).filter(([name]) => name.startsWith("pr-agent/")),
        ),
      }))
      .filter((override) => Object.keys(override.rules).length > 0),
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
  "src/review/repairImports.ts":
    'import { repair } from "../prompts/shared/repair.js";\nexport const e = repair;\n',
  "src/prompts/ask/prompt.ts": [
    'import { loadRepoPolicy } from "../../review/repoPolicy.js";',
    'import { readFileSync } from "node:fs";',
    'import type { Config } from "../../settings/config.js";',
    'import { ASK_FAILURE_MESSAGE } from "../../settings/askConstants.js";',
    'import { MAX_TOOL_ROUNDS } from "../../settings/index.js";',
    'import { escape } from "../../util/escape.js";',
    'import { renderGuestCatalogue } from "../../agent/codemode/guestCatalogue.js";',
    'import { envelope } from "../shared/safety.js";',
    'import { askOutput } from "./output.js";',
    "export const e = [loadRepoPolicy, readFileSync, ASK_FAILURE_MESSAGE, MAX_TOOL_ROUNDS];",
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

const PROMPT_SINKS_PROBE: Record<string, string> = {
  "src/agent/sinks.ts": [
    'import { prompt, render } from "../prompts/ask/prompt.js";',
    'import { foreign } from "./other.js";',
    'import * as prompts from "../prompts/ask/prompt.js";',
    'session.send("inline", { phase: "ask" });',
    "activeSession.send(`inline ${prompt}`);",
    'session.send(prompt + "suffix");',
    'const local = "inline"; session.send(local);',
    "session.send(foreign);",
    "function shadow(prompt: string) { session.send(prompt); }",
    "session.send(render(runtime));",
    "session.send(render({ runtime, nested: runtime.value }));",
    'session.send(render("inline"));',
    "const built = render(runtime); session.send(built);",
    "let mutable = render(runtime); session.send(mutable);",
    "const alias = prompt; session.send(alias);",
    "session.send(prompt, { phase: `ask`, checkpointId: foreign });",
    'boss.send("queue", "payload"); target.send("ipc");',
    "sendWithRetry(`recon`, prompt, { checkpointId: `recon` });",
    'sendWithRetry("recon", "inline");',
    "runSubmitOnlyRound(session, prompt);",
    "runSubmitOnlyRound(session, `inline`);",
    "send(session, prompt, { phase: `specialist` });",
    'send(session, "inline");',
    "session.send(prompts.prompt);",
    "session.send(prompts.render(runtime));",
    "const namespaced = prompts.render(runtime); session.send(namespaced);",
    "function sendWithRetry(phase: string, text: string) { session.send(text); text = prompt; }",
    "function runSubmitOnlyRound(session: unknown, text: string) { activeSession.send(text); text += prompt; }",
    "const send = (session: unknown, text: string) => { session.send(text); text++; };",
    "const defaultSubmitOnlySend = (activeSession: unknown, activePrompt: string) => activeSession.send(activePrompt);",
    "function shadowBuilder(render: Function) { const text = render(runtime); session.send(text); }",
    "function sendWithRetry(phase: string, text: string) { function nested(text: string) { text = prompt; } session.send(text); }",
    "function sendWithRetry(phase: string, text: string) { ({ text } = runtime); }",
    "session.send(runtime.flag ? prompt : prompts.prompt);",
    'session.send(runtime.flag ? prompt : "inline");',
    'session.send("flag" ? prompt : prompts.prompt);',
    "session.send(prompt ?? prompts.prompt); session.send(prompt || prompts.prompt);",
    "session.send(runtime.flag ? (prompt ?? prompts.prompt) : prompts.prompt);",
    "session.send(prompt ?? foreign);",
    "const selected = runtime.flag ? render(runtime) : prompts.render(runtime); session.send(selected);",
    "const templated = `inline ${prompt}`; session.send(templated);",
    "const cyclic = cyclic; session.send(cyclic);",
    'const filtered = runtime.flag ? render({ items: runtime.items.filter((item) => item.phase !== "done") }) : prompt; session.send(filtered);',
    'const inlineCallback = render({ items: runtime.items.map(() => "inline") }); session.send(inlineCallback);',
    "runSubmitOnlyRound(session, prompt, (active, text, opts) => send(active, text, opts));",
    "runSubmitOnlyRound(session, prompt, (active, text) => { text = prompt; return activeSession.send(text); });",
    "otherWrapper(session, prompt, (active, text) => session.send(text));",
    "runSubmitOnlyRound(session, prompt, opts, (active, text) => session.send(text));",
    "runSubmitOnlyRound(session, prompt, (active, text) => { const alias = text; return activeSession.send(alias); });",
    "runSubmitOnlyRound(session, prompt, (active, text) => { function nested(text: string) { session.send(text); } return activeSession.send(text); });",
    "runSubmitOnlyRound(session, prompt, (active, text) => { ({ text } = runtime); return activeSession.send(text); });",
    "runSubmitOnlyRound(session, prompt, (active, text) => session.send(active));",
    'session.send(render({ matches: runtime.value === "done", kind: typeof "value", has: "x" in runtime }));',
    "session.send(render({ items: runtime.items.map(() => `inline`) }));",
    'session.send(render({ matches: helper("inline") === runtime.value }));',
    "",
  ].join("\n"),
  "src/agent/specs.ts": [
    'import { prompt, render } from "../prompts/ask/prompt.js";',
    "runFeatureAgent({ userContent: prompt, nudge: prompt, repairPrompt: render }, runtime);",
    'runFeatureAgent({ userContent: "inline", nudge: prompt, repairPrompt: render }, runtime);',
    "runFeatureAgent({ userContent: prompt, nudge: `inline`, repairPrompt: render }, runtime);",
    'runFeatureAgent({ userContent: prompt, nudge: prompt, repairPrompt: () => "inline" }, runtime);',
    "const local = runtime; runFeatureAgent({ userContent: local, nudge: prompt, repairPrompt: render }, runtime);",
    "createSession({ systemPrompt: prompt, role: `ask` });",
    'createSession({ systemPrompt: "inline" });',
    "const systemPrompt = runtime; createSession({ systemPrompt });",
    'const tool = { description: "tool prose" }; v.description("schema prose");',
    "runFeatureAgent({ userContent: render({ runtime }), nudge: prompt, repairPrompt: render }, runtime);",
    "runFeatureAgent({ userContent: setup.userContent, nudge: spec.nudge, repairPrompt: spec.repairPrompt }, runtime);",
    "createSession({ systemPrompt: params.systemPrompt });",
    "runFeatureAgent({ repairPrompt: (error: string) => render(error) }, runtime);",
    "runFeatureAgent({ userContent: setup.other }, runtime);",
    'const value = { userContent: "inline" };',
    "const MAP = { ask: prompt, review: render(runtime) }; createSession({ systemPrompt: MAP[role] });",
    'const BAD_MAP = { ask: prompt, review: "inline" }; createSession({ systemPrompt: BAD_MAP[role] });',
    "function nestedMap() { const MAP = { ask: prompt }; createSession({ systemPrompt: MAP[role] }); }",
    "function createFeaturePiSession(params: { systemPrompt: string }) { params = runtime; }",
    "function runFeatureAgent(spec: unknown) { spec.userContent = prompt; }",
    "runFeatureAgent({ repairPrompt: (error: string) => { return render(error); } }, runtime);",
    'runFeatureAgent({ repairPrompt: () => { return "inline"; } }, runtime);',
    "session.send(spec.repairPrompt(runtime));",
    "session.send(render({ userContent: runtime.other }));",
    "const TYPED_MAP = { ask: prompt } satisfies Record<string, string>; createSession({ systemPrompt: TYPED_MAP[role] });",
    "const task = { briefMessage: render(runtime) }; send(session, task.briefMessage);",
    'const taskWithLiteral = { briefMessage: "inline" }; send(session, taskWithLiteral.briefMessage);',
    "send(session, params.briefMessage);",
    "",
  ].join("\n"),
  "src/agent/compaction.ts": [
    'import { prompt, render } from "../prompts/compaction/prompt.js";',
    "streamFn(model, { messages: [{ role: `user`, content: [{ type: `text`, text: prompt }], timestamp: Date.now() }] }, { cacheRetention: `none` });",
    'streamFn(model, { messages: [{ content: [{ text: "inline" }] }] });',
    "streamFn(model, normalizeContext({ messages: [{ content: [{ text: `inline` }] }] }));",
    "const local = runtime; streamFn(model, { messages: [{ content: [{ text: local }] }] });",
    "const built = render(runtime); streamFn(model, normalizeContext({ messages: [{ content: [{ text: built }] }] }));",
    "streamFn(model, { messages: [{ content: [{ text: render(runtime) }] }] });",
    "",
  ].join("\n"),
  "src/agent/stores.ts": [
    'import { prompt, render } from "../prompts/ask/prompt.js";',
    'spec.userContent = "inline";',
    'spec["nudge"] = `x`;',
    "spec.systemPrompt += prompt;",
    "spec.userContent = render(runtime);",
    'spec["nudge"] = prompt;',
    'const computedBad = { ["repairPrompt"]: "inline" };',
    'const computedGood = { ["userContent"]: render(runtime) };',
    "spec.userContent = foreign;",
    'spec.other = "ordinary";',
    'spec["other"] = `ordinary`;',
    'spec["briefMessage"] ||= prompt;',
    "spec.nudge ??= prompt;",
    "spec.userContent = spec.nudge;",
    "spec.systemPrompt += render(runtime);",
    'function runFeatureAgent(spec: unknown) { spec["userContent"] = prompt; }',
    "",
  ].join("\n"),
  "src/prompts/ask/prompt.ts":
    'session.send("inline"); createSession({ systemPrompt: "inline" });\n',
  "test/promptSinks.ts": 'session.send("inline"); createSession({ systemPrompt: "inline" });\n',
  "scripts/promptSinks.ts": 'session.send("inline"); createSession({ systemPrompt: "inline" });\n',
};

const PROMPT_STYLE_PROBE: Record<string, string> = {
  "src/prompts/ask/prompt.ts": [
    'export const caps = "Do SOMETHING now.";',
    "export const template = `Read CAREFULLY ${runtime}.`;",
    'export const pressure = "You MUST read this.";',
    'export const never = "NEVER skip the read.";',
    'export const always = "ALWAYS check the path.";',
    'export const critical = "This is CRITICAL.";',
    'export const important = "This is IMPORTANT.";',
    'export const phrase = "Under no circumstances skip the read.";',
    'export const bang = "Read the file!";',
    'const helper = "Read LOUDLY."; export const alias = helper;',
    'export const allowed = "Use API, JSON, PR, ASD-STE100, UTF-8, SQL/XSS and JS/TS. Report P0/P1 and AND/OR.";',
    'export const contract = "detail (required): MUST BE SHORT!";',
    'export const tag = "<UNTRUSTED_EVIDENCE>";',
    'export const flags = new RegExp(runtime, "GI");',
    'export const modal = "You must read the file. Never invent evidence. Always cite the path.";',
    'export const enums = "Use severity values P0, P1, P2, or P3, never CRITICAL, HIGH, or MEDIUM.";',
    'export const identifiers = "Read AGENTS.md, CLAUDE.md, GEMINI.md and `HEAD`. Use `SEARCH_TRUNCATED` and `TODO`.";',
    'export const sizes = "Use size values XS, XL, or XXL.";',
    'export const method = "Use GET /health and flowchart LR or TB.";',
    'export const comparison = "Use != and !==. Keep !value and https://example.com/!x.";',
    'const unused = "IGNORE this!";',
    'export type Kind = "LOUD";',
    "export const quotedBang = 'Say \"Done!\"';",
    "export const helperCall = () => helper;",
    'export const emphasizedEnum = "The risk is HIGH.";',
    "export const split = `Read ${runtime} NOW!`;",
    'export const quotedPressure = "Use `MUST` for emphasis.";',
    'export const quotedUnknown = "Use `SHOUT` for emphasis.";',
    'export const bareTag = wrapUntrustedBlock("UNTRUSTED_EVIDENCE", runtime);',
    'export const enumThenPressure = "Use severity values P0, P1. This is CRITICAL.";',
    'export default "Read FORCEFULLY.";',
    'const specifierText = "Read SOFTLY.";',
    "export { specifierText as guidance };",
    'export const bareGet = "Use GET now.";',
    'export const bareHead = "Read HEAD now.";',
    'export const bareLr = "Use LR now.";',
    'export const bareTb = "Use TB now.";',
    'export const bareXs = "Use XS now.";',
    'export const bareXl = "Use XL now.";',
    'export const bareXxl = "Use XXL now.";',
    'export const bareAgents = "Ask AGENTS now.";',
    'export const bareClaude = "Ask CLAUDE now.";',
    'export const bareGemini = "Ask GEMINI now.";',
    'export const rawTag = "<note>";',
    'export const pattern = new RegExp("IMPORTANT", "GI");',
    'export const wrappedText = wrapUntrustedBlock("note", "IMPORTANT");',
    'export const dashedContract = "- path: MUST BE RELATIVE!";',
    'export const quotedContract = "`path`: MUST BE RELATIVE!";',
    'export const joinedWords = "Hello!World";',
    'export const parenthesizedBang = "(Read now!)";',
    "",
  ].join("\n"),
  "src/prompts/ask/context.ts": [
    'export { x } from "./SHOUT.js";',
    'import { x as importedAlias } from "./SHOUT.js";',
    "export { importedAlias as importedPrompt };",
    "",
  ].join("\n"),
  "src/prompts/shared/safety.ts": [
    'const frozenHelper = "MUST KEEP THIS!";',
    "export const FINDING_ANTI_SUPPRESSION = frozenHelper;",
    'export function wrapUntrustedBlock() { return "NEVER CHANGE THIS!"; }',
    'export const userSupplementGuidance = "IMPORTANT!";',
    'export const active = "Read QUIETLY.";',
    'const original = "ALWAYS KEEP THIS!"; export { original as repoPolicyGuidance };',
    "",
  ].join("\n"),
  "src/agent/tools/workspaceToolset.ts": [
    'const prose = "Read CAREFULLY.";',
    "export const tool = { description: prose };",
    "export const other = { description: `Read ${runtime} LOUDLY!` };",
    'export const schema = v.description("You MUST read this.");',
    'export const allowed = { description: "Read the PR head." };',
    'export const param = v.description("path: MUST BE RELATIVE!");',
    'export const result = { error: "IMPORTANT!" };',
    'export const computed = { ["description"]: "Read SLOWLY." };',
    'export const nested = { description: flag ? "Read FAST." : "Read JSON." };',
    'const paramText = "Read DEEPLY."; export const alias = v.description(paramText);',
    "",
  ].join("\n"),
  "src/agent/codemode/guestCatalogue.ts":
    'export function renderExecuteDescription() { return "Run QUIETLY!"; }\n',
  "src/agent/description/fooSchema.ts": [
    'export const tool = { description: "Read SHOUT." };',
    'export const param = v.description("Read QUIETLY.");',
    "",
  ].join("\n"),
  "src/other.ts": 'export const value = { description: "IMPORTANT!" };\n',
  "test/promptStyle.ts": 'export const value = "IMPORTANT!";\n',
};

describe("architecture rules", () => {
  it("locks prompt wording while preserving contracts, identifiers, and frozen exports", () => {
    expect(
      lintWithPlugin(PROMPT_STYLE_PROBE, {
        config: { rules: { "pr-agent/prompt-style": "error" } },
      }).lines("prompt-style"),
    ).toEqual({
      "src/prompts/ask/prompt.ts": [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 23, 25, 26, 26, 27, 28, 30, 31, 32, 34, 35, 36, 37, 38, 39,
        40, 41, 42, 43, 45, 46, 50,
      ],
      "src/prompts/ask/context.ts": [],
      "src/prompts/shared/safety.ts": [5],
      "src/agent/tools/workspaceToolset.ts": [1, 3, 3, 4, 8, 9, 10],
      "src/agent/codemode/guestCatalogue.ts": [1, 1],
      "src/agent/description/fooSchema.ts": [1, 2],
      "src/other.ts": [],
      "test/promptStyle.ts": [],
    });
    const ratchet = Object.fromEntries(
      Object.entries(PROMPT_STYLE_PROBE).filter(([file]) => !file.startsWith("src/prompts/ask/")),
    );
    expect(lintWithPlugin(ratchet).lines("prompt-style")).toEqual({
      "src/prompts/shared/safety.ts": [5],
      "src/agent/tools/workspaceToolset.ts": [1, 3, 3, 4, 8, 9, 10],
      "src/agent/codemode/guestCatalogue.ts": [1, 1],
      "src/agent/description/fooSchema.ts": [],
      "src/other.ts": [],
      "test/promptStyle.ts": [],
    });
    expect(
      repoPluginRules()
        .overrides?.filter((override) => override.rules["pr-agent/prompt-style"] === "error")
        .map((override) => override.files),
    ).toEqual([
      [
        "src/prompts/shared/**",
        "src/prompts/correctness/**",
        "src/prompts/quality/**",
        "src/prompts/security/**",
        "src/prompts/tests/**",
        "src/agent/tools/workspaceToolset.ts",
        "src/agent/tools/context7Tools.ts",
        "src/agent/tools/toolParams.ts",
        "src/agent/tools/defineWorkspaceTool.ts",
        "src/agent/codemode/guestCatalogue.ts",
        "src/review/orchestrator/specialistTools.ts",
      ],
    ]);
  });

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
      "src/review/repairImports.ts": [],
      "src/prompts/ask/prompt.ts": [1, 2],
      "src/prompts/shared/context.ts": [1, 2],
      "test/promptImports.ts": [],
    });
  });

  it("reports prompt rules only when the config enables them", () => {
    const run = lintWithPlugin(
      { ...PROMPT_LAYOUT_PROBE, ...PROMPT_IMPORTS_PROBE, ...PROMPT_SINKS_PROBE },
      { config: { rules: { "pr-agent/prompt-imports": "error" } } },
    );
    expect(Object.values(run.lines("prompt-layout")).flat()).toEqual([]);
    expect(Object.values(run.lines("prompt-sinks")).flat()).toEqual([]);
    expect(run.lines("prompt-imports")["src/prompts/shared/context.ts"]).toEqual([1, 2]);
  });

  it("locks prompt arguments without treating runtime options or other sends as prompts", () => {
    expect(lintWithPlugin(PROMPT_SINKS_PROBE).lines("prompt-sinks")).toEqual({
      "src/agent/sinks.ts": [
        4, 5, 6, 7, 8, 9, 12, 14, 19, 21, 23, 27, 28, 29, 31, 33, 35, 39, 41, 42, 44, 46, 47, 48,
        50, 51, 52, 54, 55,
      ],
      "src/agent/specs.ts": [3, 4, 5, 6, 8, 9, 15, 16, 18, 19, 20, 21, 23, 28],
      "src/agent/compaction.ts": [3, 4, 5],
      "src/agent/stores.ts": [2, 3, 4, 7, 9, 12, 13, 15, 16],
      "src/prompts/ask/prompt.ts": [],
      "test/promptSinks.ts": [],
      "scripts/promptSinks.ts": [],
    });
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
