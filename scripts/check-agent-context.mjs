import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { PROMPT_ROLES } from "./lint/prompts.mjs";

const rootArgIndex = process.argv.indexOf("--root");
const ROOT =
  rootArgIndex !== -1 && process.argv[rootArgIndex + 1]
    ? path.resolve(process.argv[rootArgIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AGENTS_BUDGET = 16 * 1024;
const CLAUDE_BUDGET = 512;
const CONTEXT_BUDGET = 8 * 1024;
const MAX_REPO_POLICY_FILES = 20;
const MAX_REPO_POLICY_FILE_BYTES = 8 * 1024;
const MAX_REPO_POLICY_TOTAL_BYTES = 32 * 1024;
const MAX_REPO_POLICY_INSTRUCTION_CHARS = 1000;

const ROOT_PATH_TOKENS = new Set([
  ".env.example",
  ".npmrc",
  ".oxlintrc.json",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "README.md",
  "docker-compose.dev.yml",
  "docker-compose.prod.yml",
  "docker-compose.yml",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "tsconfig.json",
]);

const RETIRED_ADR_PATTERN = /(?:docs\/adr\b|\bADR[- ]?\d+\b|\badrs?\b)/i;
const CONTEXT_BULLET_PATTERN = /^- \*\*([^*]+)\*\*\. [A-Z][^.!?]*\.$/;
const CONTEXT_BANNED_PATTERNS = [
  [/\d+/, "numbers"],
  [
    /(?:\b(?:src|test|docs|scripts|site|migrations)\/|\.pr-agent\/|\.(?:ts|tsx|js|mjs|cjs|sql|mdc|json|ya?ml|md)\b)/,
    "file paths",
  ],
  [/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/, "environment variables"],
  [/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/, "snake_case identifiers"],
];

const failures = [];
const fail = (msg) => failures.push(msg);

function read(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    fail(`missing ${rel}`);
    return "";
  }
  return fs.readFileSync(abs, "utf8");
}

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(abs, predicate));
    } else if (entry.isFile() && predicate(entry.name, abs)) {
      results.push(path.relative(ROOT, abs).split(path.sep).join("/"));
    }
  }
  return results.toSorted((a, b) => a.localeCompare(b));
}

function checkContextGlossary(raw) {
  for (const [pattern, label] of CONTEXT_BANNED_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      fail(`CONTEXT.md must not contain ${label} (${JSON.stringify(match[0])})`);
    }
  }
  if (raw.includes("`")) {
    fail("CONTEXT.md must not contain inline code or fenced blocks");
  }
  if (raw.includes("—")) {
    fail("CONTEXT.md must not contain em dashes");
  }
  const lines = raw.replaceAll("\r\n", "\n").trimEnd().split("\n");
  if (
    lines.length < 5 ||
    lines[0] !== "# Context glossary" ||
    lines[1] !== "" ||
    !/^[A-Z][^.!?]*\.$/.test(lines[2]) ||
    lines[3] !== ""
  ) {
    fail("CONTEXT.md must start with '# Context glossary' and a single-sentence preamble");
    return;
  }
  const seenTerms = new Set();
  for (let index = 4; index < lines.length; index += 1) {
    const bulletMatch = lines[index].match(CONTEXT_BULLET_PATTERN);
    if (!bulletMatch) {
      fail(`CONTEXT.md line ${index + 1} must be a single-sentence '**Term**. Sentence.' bullet`);
      continue;
    }
    const term = bulletMatch[1];
    if (seenTerms.has(term)) {
      fail(`CONTEXT.md defines duplicate term ${JSON.stringify(term)}`);
    }
    seenTerms.add(term);
  }
}

const agents = read("AGENTS.md");
const claude = read("CLAUDE.md");
const context = read("CONTEXT.md");
const agentsBytes = Buffer.byteLength(agents, "utf8");
const claudeBytes = Buffer.byteLength(claude, "utf8");
const contextBytes = Buffer.byteLength(context, "utf8");

console.log(`AGENTS.md ${agentsBytes} bytes (budget ${AGENTS_BUDGET})`);
console.log(`CLAUDE.md ${claudeBytes} bytes (budget ${CLAUDE_BUDGET})`);
console.log(`CONTEXT.md ${contextBytes} bytes (budget ${CONTEXT_BUDGET})`);

if (agentsBytes > AGENTS_BUDGET) {
  fail(`AGENTS.md is ${agentsBytes} bytes, over the ${AGENTS_BUDGET} byte always-loaded budget`);
}
if (claudeBytes > CLAUDE_BUDGET) {
  fail(`CLAUDE.md is ${claudeBytes} bytes, over the ${CLAUDE_BUDGET} byte pointer budget`);
}
if (contextBytes > CONTEXT_BUDGET) {
  fail(`CONTEXT.md is ${contextBytes} bytes, over the ${CONTEXT_BUDGET} byte glossary budget`);
}
if (context.length > 0) {
  checkContextGlossary(context);
}
if (!claude.includes("@AGENTS.md")) {
  fail("CLAUDE.md must point at AGENTS.md");
}

if (fs.existsSync(path.join(ROOT, "docs", "adr"))) {
  fail("docs/adr must remain retired");
}

const leadingWords = [
  "Vocabulary",
  "Topology",
  "Feature",
  "Knob",
  "Module",
  "Behaviour",
  "Queue",
  "Surfaces",
  "Stack",
  "Ship",
  "Voice",
  "Public docs",
];
for (const word of leadingWords) {
  if (!agents.includes(`**${word}**`)) fail(`AGENTS.md index is missing **${word}**`);
}
if (agents.includes("**ADR**")) {
  fail("AGENTS.md index must not include retired **ADR** pointer");
}

const buried = [
  "## How it works",
  "## Where code lives",
  "## Hit every runtime surface",
  "## Public documentation",
];
for (const heading of buried) {
  if (agents.includes(heading)) fail(`AGENTS.md still inlines ${heading}`);
}

const relocated = [
  ["docs/topology.md", "Lifecycle claims and watchdog hops do not spend work retries."],
  ["docs/topology.md", "```mermaid"],
  ["docs/runtime-surfaces.md", "Acknowledgement and CI refresh are fire-and-forget jobs."],
  ["docs/local-stack.md", "Web-only runs accept work but do not publish reviews."],
  ["docs/ship.md", "A passing typecheck alone does not prove webhook intake"],
  ["docs/public-voice.md", "Pratham's way of hosting"],
];
for (const [rel, needle] of relocated) {
  const body = read(rel);
  if (!body.includes(needle)) fail(`${rel} is missing ${JSON.stringify(needle)}`);
  if (agents.includes(needle)) fail(`AGENTS.md still contains ${JSON.stringify(needle)}`);
}

const diagramHosts = ["AGENTS.md", "README.md", "docs/development.md", "docs/topology.md"];
for (const rel of diagramHosts) {
  const count = (read(rel).match(/```mermaid/g) ?? []).length;
  const expected = rel === "docs/topology.md" ? 1 : 0;
  if (count !== expected) fail(`${rel} has ${count} mermaid fences, expected ${expected}`);
}

function stripFencedBlocks(markdown) {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
}

function linkTargets(rel, body) {
  const dir = path.dirname(rel);
  const prose = stripFencedBlocks(body);
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = match[1];
    if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("mailto:"))
      continue;
    if (raw.startsWith("#")) continue;
    const [filePart] = raw.split("#");
    if (filePart.length === 0) continue;
    const abs = path.resolve(ROOT, dir, filePart);
    const rooted = path.relative(ROOT, abs);
    if (rooted.startsWith("..") || path.isAbsolute(rooted)) {
      fail(`${rel} link escapes the repo: ${raw}`);
      continue;
    }
    if (!fs.existsSync(abs)) fail(`${rel} link target missing: ${raw}`);
  }
}

const skillFiles = walkFiles(path.join(ROOT, "skills"), () => true);
const markdownDocs = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  "README.md",
  ...walkFiles(path.join(ROOT, "docs"), (name) => name.endsWith(".md")),
  ...skillFiles.filter((rel) => rel.endsWith(".md")),
]);
for (const rel of markdownDocs) {
  linkTargets(rel, read(rel));
}

const adrBannedFiles = new Set([
  ...markdownDocs,
  ...walkFiles(path.join(ROOT, ".pr-agent"), () => true),
  ...skillFiles,
  ...walkFiles(path.join(ROOT, "scripts", "lint"), (name) => name.endsWith(".mjs")),
  "site/lib/llmsKnowledge.ts",
  "site/lib/agentResources.ts",
  "site/lib/agentDiscovery.ts",
  "site/public/llms.txt",
]);
for (const rel of adrBannedFiles) {
  const body = read(rel);
  const match = body.match(RETIRED_ADR_PATTERN);
  if (match) {
    fail(`${rel} references retired ADR documentation (${JSON.stringify(match[0])})`);
  }
}

function expandBraces(pattern) {
  const match = pattern.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!match) return [pattern];
  return match[2].split(",").flatMap((option) => expandBraces(`${match[1]}${option}${match[3]}`));
}

function expandPlaceholders(pattern) {
  if (!pattern.includes("<role>")) return [pattern];
  return PROMPT_ROLES.map((role) => pattern.replaceAll("<role>", role));
}

function patternResolvesInRepo(pattern) {
  const variants = expandBraces(pattern).flatMap(expandPlaceholders);
  return variants.every((variant) => {
    const clean = variant.replace(/\/$/, "");
    if (clean.length === 0) return false;
    if (!clean.includes("*")) return fs.existsSync(path.join(ROOT, clean));
    return fs.globSync(clean, { cwd: ROOT }).length > 0;
  });
}

function isRepoRootedToken(token) {
  if (ROOT_PATH_TOKENS.has(token)) return true;
  return /^(?:src|test|docs|scripts|site|migrations|\.pr-agent)\//.test(token);
}

function checkRepoPolicyRules() {
  const policyDir = path.join(ROOT, ".pr-agent");
  if (!fs.existsSync(policyDir) || !fs.statSync(policyDir).isDirectory()) {
    fail("missing .pr-agent directory");
    return;
  }
  const mdcNames = [];
  for (const entry of fs.readdirSync(policyDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mdc")) mdcNames.push(entry.name);
    else fail(`.pr-agent must contain only .mdc files, found ${entry.name}`);
  }
  const mdcFiles = mdcNames.toSorted((a, b) => a.localeCompare(b));
  if (mdcFiles.length === 0) {
    fail(".pr-agent must contain at least one .mdc rule");
    return;
  }
  if (mdcFiles.length > MAX_REPO_POLICY_FILES) {
    fail(`.pr-agent has ${mdcFiles.length} .mdc files, over cap ${MAX_REPO_POLICY_FILES}`);
  }
  let totalBytes = 0;
  for (const name of mdcFiles) {
    const rel = path.posix.join(".pr-agent", name);
    const raw = fs.readFileSync(path.join(policyDir, name), "utf8");
    const bytes = Buffer.byteLength(raw, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_REPO_POLICY_FILE_BYTES) {
      fail(`${rel} is ${bytes} bytes, over per-file cap ${MAX_REPO_POLICY_FILE_BYTES}`);
    }
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) {
      fail(`${rel} is missing YAML frontmatter`);
      continue;
    }
    let parsed;
    try {
      parsed = parseYaml(fmMatch[1]);
    } catch (error) {
      fail(
        `${rel} frontmatter YAML invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(`${rel} frontmatter must be a YAML mapping`);
      continue;
    }
    for (const key of Object.keys(parsed)) {
      if (key !== "globs" && key !== "alwaysApply") {
        fail(`${rel} frontmatter has unsupported key ${JSON.stringify(key)}`);
      }
    }
    if (Object.hasOwn(parsed, "globs")) {
      if (
        !Array.isArray(parsed.globs) ||
        parsed.globs.length === 0 ||
        parsed.globs.some((glob) => typeof glob !== "string" || glob.trim().length === 0)
      ) {
        fail(`${rel} globs must be a non-empty array of strings`);
      } else {
        for (const glob of parsed.globs) {
          if (!patternResolvesInRepo(glob)) {
            fail(`${rel} glob matches no repo files: ${glob}`);
          }
        }
      }
    } else if (parsed.alwaysApply !== true) {
      fail(`${rel} must specify globs or alwaysApply: true`);
    }
    const body = fmMatch[2].trim();
    if (body.length === 0) {
      fail(`${rel} body is empty`);
      continue;
    }
    if (body.length > MAX_REPO_POLICY_INSTRUCTION_CHARS) {
      fail(`${rel} body is ${body.length} chars, over cap ${MAX_REPO_POLICY_INSTRUCTION_CHARS}`);
    }
    let anchorCount = 0;
    for (const tokenMatch of body.matchAll(/`([^`\n]+)`/g)) {
      const candidate = tokenMatch[1].split("::")[0];
      if (candidate.includes(" ") || candidate.startsWith("http")) continue;
      if (!isRepoRootedToken(candidate)) continue;
      anchorCount += 1;
      if (!patternResolvesInRepo(candidate)) {
        fail(`${rel} cites missing repo path: ${candidate}`);
      }
    }
    if (anchorCount === 0) {
      fail(`${rel} body must cite at least one resolvable repo path`);
    }
  }
  if (totalBytes > MAX_REPO_POLICY_TOTAL_BYTES) {
    fail(`.pr-agent total size is ${totalBytes} bytes, over cap ${MAX_REPO_POLICY_TOTAL_BYTES}`);
  }
}

checkRepoPolicyRules();

function headingSlugs(markdown) {
  const slugs = new Set();
  for (const match of markdown.matchAll(/^#{1,6} +(.+)$/gm)) {
    const slug = match[1]
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
    slugs.add(slug);
  }
  return slugs;
}

const agentsSlugs = headingSlugs(agents);
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }
    if (!entry.name.endsWith(".md") && !entry.name.endsWith(".mdc")) continue;
    const rel = path.relative(ROOT, abs);
    const body = fs.readFileSync(abs, "utf8");
    for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]*AGENTS\.md#([^)\s]+))\)/g)) {
      const slug = decodeURIComponent(match[2]).toLowerCase();
      if (!agentsSlugs.has(slug)) fail(`${rel} links to missing AGENTS.md heading #${slug}`);
    }
  }
}
walk(ROOT);

if (failures.length > 0) {
  console.error(`Agent context check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Agent context check passed.");
