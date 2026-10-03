import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const ROOT = path.resolve(
  rootArg === -1
    ? path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
    : args[rootArg + 1],
);
const SITE = path.join(ROOT, "site");
const CSS_PATH = path.join(SITE, "app", "globals.css");
const DOC_PATH = path.join(SITE, "DESIGN.md");
const SECTION_PATH = path.join(SITE, "components", "section.tsx");
const BASELINE_PATH = path.join(ROOT, "scripts", "baselines", "site-design-baseline.json");
const BOOTSTRAP = args.includes("--bootstrap");
const SCAN_DIRS = [path.join(SITE, "app"), path.join(SITE, "components")];

// Short hex needs a letter so a pull request number such as `#284` is not read as a colour.
const RAW_COLOR =
  /(?<![\w&-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|(?=[0-9]*[a-f])[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*[\d.][^)]*\)/gi;
const COLOR_UTILITY =
  /^-?(?:bg|text|border(?:-[xytblrse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|decoration|caret|accent|placeholder|shadow|inset-shadow|inset-ring)-[a-z][a-z0-9-]*(?:\/\d+)?$/;
const SECTION_TITLE_SIZE = /text-\[clamp\(1\.875rem,3\.4vw,2\.625rem\)\]/;
const CARD_RECIPE = ["rounded-lg", "bg-surface", "shadow-card"];
const CHIP_RECIPE = ["rounded-xs", "bg-surface-raised", "px-2", "py-1", "shadow-ring"];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return /\.(tsx|css)$/.test(entry.name) ? [full] : [];
  });
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function globalPattern(pattern) {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
}

function matchAll(file, text, pattern) {
  return [...text.matchAll(globalPattern(pattern))].map((m) => ({
    file,
    line: lineAt(text, m.index),
    match: m[0],
  }));
}

/** String and template literal bodies, where class names live in TSX. */
function stringLiterals(text) {
  return [...text.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => ({
    index: m.index,
    body: m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, " "),
  }));
}

function utilityOf(token) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++;
    else if (token[i] === "]") depth--;
    else if (token[i] === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}

/**
 * Flat CSS walk: every declaration and block prelude with the stack of blocks around it. Enough
 * for globals.css, which never puts braces inside strings.
 */
function parseCss(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const blocks = [];
  const declarations = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch !== "{" && ch !== "}" && ch !== ";") continue;
    const chunk = clean.slice(start, i);
    const at = start + chunk.length - chunk.trimStart().length;
    if (ch === "{") {
      const prelude = chunk.trim();
      blocks.push({ prelude, stack: [...stack], line: lineAt(clean, at) });
      stack.push(prelude);
    } else {
      if (chunk.trim()) declarations.push({ text: chunk.trim(), stack: [...stack], index: at });
      if (ch === "}") stack.pop();
    }
    start = i + 1;
  }
  return { blocks, declarations };
}

async function tailwindCompiler(css) {
  const require = createRequire(path.join(SITE, "package.json"));
  const entry = require.resolve("tailwindcss");
  const { compile } = require(entry);
  const pkgDir = path.join(path.dirname(entry), "..");
  return compile(css, {
    base: path.dirname(CSS_PATH),
    loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(pkgDir, "index.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
}

/** Utilities Tailwind generates nothing for: an undefined token, or the reset stock palette. */
async function unbuiltColorUtilities(css, componentClasses, tsxFiles) {
  const candidates = new Map();
  for (const { file, text } of tsxFiles) {
    for (const literal of stringLiterals(text)) {
      for (const m of literal.body.matchAll(/\S+/g)) {
        const utility = utilityOf(m[0]);
        const skip =
          !COLOR_UTILITY.test(utility) || componentClasses.has(utility) || candidates.has(utility);
        if (skip) continue;
        candidates.set(utility, { file, line: lineAt(text, literal.index), match: m[0] });
      }
    }
  }
  const compiler = await tailwindCompiler(css);
  let size = compiler.build([]).length;
  const hits = [];
  for (const [utility, hit] of candidates) {
    const next = compiler.build([utility]).length;
    if (next === size) hits.push(hit);
    size = next;
  }
  return hits;
}

function themeTokens(css) {
  const theme = css.declarations.filter((d) => d.stack[0] === "@theme");
  return theme
    .map((d) => /^(--[a-z0-9-]+)\s*:/.exec(d.text)?.[1])
    .filter((name) => name && !name.endsWith("-"));
}

async function collect() {
  const files = SCAN_DIRS.flatMap(walk).map((file) => ({
    file: path.relative(ROOT, file),
    text: fs.readFileSync(file, "utf8"),
  }));
  const tsx = files.filter((f) => f.file.endsWith(".tsx"));
  const cssText = fs.readFileSync(CSS_PATH, "utf8");
  const cssFile = path.relative(ROOT, CSS_PATH);
  const css = parseCss(cssText);
  const tokens = new Set(themeTokens(css));
  const componentClasses = new Set(
    css.blocks.flatMap((b) => [...b.prelude.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1])),
  );
  const colorNames = new Set(
    [...tokens].filter((t) => t.startsWith("--color-")).map((t) => t.slice(8)),
  );
  const cssHit = (d, m) => ({
    file: cssFile,
    line: lineAt(cssText, d.index + m.index),
    match: m[0],
  });
  const outside = (...roots) => css.declarations.filter((d) => !roots.includes(d.stack[0]));
  const inTsx = (pattern, filter = () => true) =>
    tsx.filter(filter).flatMap(({ file, text }) => matchAll(file, text, pattern));
  const inDecls = (decls, pattern) =>
    decls.flatMap((d) => [...d.text.matchAll(globalPattern(pattern))].map((m) => cssHit(d, m)));
  const recipeClones = (recipe) =>
    tsx.flatMap(({ file, text }) =>
      stringLiterals(text)
        .filter((l) => {
          const set = new Set(l.body.split(/\s+/));
          return recipe.every((c) => set.has(c));
        })
        .map((l) => ({ file, line: lineAt(text, l.index), match: recipe.join(" ") })),
    );

  const doc = fs.readFileSync(DOC_PATH, "utf8");
  const docFile = path.relative(ROOT, DOC_PATH);
  const docParity = [
    ...[...tokens]
      .filter((t) => !new RegExp(`${t}(?![\\w-])`).test(doc))
      .map((t) => ({ file: docFile, line: 0, match: `${t} is in @theme but not documented` })),
    ...[...doc.matchAll(/--color-([a-z][a-z0-9-]*[a-z0-9])\b/g)]
      .filter((m) => !colorNames.has(m[1]))
      .map((m) => ({
        file: docFile,
        line: lineAt(doc, m.index),
        match: `${m[0]} is not in @theme`,
      })),
  ];

  return {
    "palette-reset": css.declarations.some(
      (d) => d.stack[0] === "@theme" && /^--color-\*\s*:\s*initial$/.test(d.text),
    )
      ? []
      : [{ file: cssFile, line: 0, match: "@theme lost `--color-*: initial`" }],
    "undefined-color-token": [
      ...(await unbuiltColorUtilities(cssText, componentClasses, tsx)),
      ...inDecls(css.declarations, /var\(--color-[a-z0-9-]+\)/).filter(
        (h) => !colorNames.has(h.match.slice(12, -1)),
      ),
    ],
    "raw-color": [...inTsx(RAW_COLOR), ...inDecls(outside(":root"), RAW_COLOR)],
    "primitive-read": [
      ...inTsx(/--palette-/),
      ...inDecls(outside(":root", "@theme"), /var\(--palette-[a-z0-9-]+\)/),
    ],
    "shadow-var": [
      ...inTsx(/var\(--shadow-(?!ink\b)/),
      ...inDecls(outside("@theme"), /var\(--shadow-(?!ink\b)[a-z0-9-]+\)/),
    ],
    "arbitrary-type-size": inTsx(/\btext-\[(?!clamp\()[^\]]*\]/),
    "arbitrary-value": inTsx(/\b[a-z][a-z0-9]*(?:-[a-z0-9.]+)*-\[[^\]\s"'`]+\](?![\w/-]*:)/),
    "transition-all": [
      ...inTsx(/\btransition-all\b/),
      ...inDecls(css.declarations, /^transition(?:-property)?\s*:\s*all\b/),
    ],
    "hover-unguarded": css.blocks
      .filter(
        (b) => b.prelude.includes(":hover") && !b.stack.some((s) => /\(hover:\s*hover\)/.test(s)),
      )
      .map((b) => ({ file: cssFile, line: b.line, match: b.prelude })),
    "card-clone": recipeClones(CARD_RECIPE),
    "chip-clone": recipeClones(CHIP_RECIPE),
    "section-title-clone": inTsx(
      SECTION_TITLE_SIZE,
      ({ file }) => path.join(ROOT, file) !== SECTION_PATH,
    ),
    "docs-token-parity": docParity,
  };
}

const HINTS = {
  "palette-reset": "Keep `--color-*: initial` in @theme so only semantic colours become utilities.",
  "undefined-color-token": "Use a `--color-*` token declared in @theme, or add the token first.",
  "raw-color":
    "Add a `--palette-*` primitive and a semantic `--color-*` token, then use the utility.",
  "primitive-read": "Read a semantic `--color-*` token, not a `--palette-*` primitive.",
  "shadow-var":
    "Use a `shadow-*` utility or `@apply shadow-*`; `var(--shadow-*)` loses the wash ink.",
  "arbitrary-type-size": "Use a stock size or a `--text-*` token (badge, meta, label, ui, lead).",
  "arbitrary-value": "Use a theme value, or name the value as a token before reaching for `[...]`.",
  "transition-all": "List the properties that change instead of `all`.",
  "hover-unguarded": "Wrap `:hover` in `@media (hover: hover)` so touch screens do not stick.",
  "card-clone": "Use the `.card` class.",
  "chip-clone": "Use the `.chip` class.",
  "section-title-clone": "Use `SectionTitle` or `SectionHeading` from components/section.tsx.",
  "docs-token-parity": "Document every @theme token in site/DESIGN.md, and only name real tokens.",
};

const hits = await collect();

if (BOOTSTRAP) {
  if (process.env.CI === "true") {
    console.error(
      "Refusing --bootstrap under CI=true. Baselines only shrink after landing, never grow in CI.",
    );
    process.exit(1);
  }
  const baseline = {};
  for (const [id, list] of Object.entries(hits)) baseline[id] = { count: list.length };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Baseline bootstrapped at ${path.relative(ROOT, BASELINE_PATH)}.`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error(
    `Missing ${path.relative(ROOT, BASELINE_PATH)}. Run: nub run check:site-design -- --bootstrap`,
  );
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
let failed = false;
for (const [id, list] of Object.entries(hits)) {
  const expected = baseline[id]?.count ?? 0;
  const actual = list.length;
  console.log(`  ${id}  ${actual} (baseline ${expected})  ${actual <= expected ? "ok" : "FAIL"}`);
  if (actual <= expected) continue;
  failed = true;
  console.log(`FAIL ${id} +${actual - expected} (baseline ${expected})`);
  for (const hit of list) console.log(`    ${hit.file}:${hit.line}  ${hit.match}`);
  console.log(`  ${HINTS[id]}`);
}
if (failed) process.exit(1);
console.log("Site design check passed.");
