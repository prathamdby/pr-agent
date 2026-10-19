import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_BUDGET = 16 * 1024;
const CLAUDE_BUDGET = 512;

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

const agents = read("AGENTS.md");
const claude = read("CLAUDE.md");
const agentsBytes = Buffer.byteLength(agents, "utf8");
const claudeBytes = Buffer.byteLength(claude, "utf8");

console.log(`AGENTS.md ${agentsBytes} bytes (budget ${AGENTS_BUDGET})`);
console.log(`CLAUDE.md ${claudeBytes} bytes (budget ${CLAUDE_BUDGET})`);

if (agentsBytes > AGENTS_BUDGET) {
  fail(`AGENTS.md is ${agentsBytes} bytes, over the ${AGENTS_BUDGET} byte always-loaded budget`);
}
if (claudeBytes > CLAUDE_BUDGET) {
  fail(`CLAUDE.md is ${claudeBytes} bytes, over the ${CLAUDE_BUDGET} byte pointer budget`);
}
if (!claude.includes("@AGENTS.md")) {
  fail("CLAUDE.md must point at AGENTS.md");
}

const leadingWords = [
  "Vocabulary",
  "Topology",
  "Feature",
  "Knob",
  "Module",
  "Behaviour",
  "Queue",
  "ADR",
  "Surfaces",
  "Stack",
  "Ship",
  "Voice",
  "Public docs",
];
for (const word of leadingWords) {
  if (!agents.includes(`**${word}**`)) fail(`AGENTS.md index is missing **${word}**`);
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

function linkTargets(rel, body) {
  const dir = path.dirname(rel);
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
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

linkTargets("AGENTS.md", agents);
linkTargets("CLAUDE.md", claude);
for (const rel of [
  "docs/topology.md",
  "docs/runtime-surfaces.md",
  "docs/local-stack.md",
  "docs/ship.md",
  "docs/public-voice.md",
  "docs/development.md",
]) {
  linkTargets(rel, read(rel));
}

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
