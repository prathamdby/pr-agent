import path from "node:path";

export const PROMPTS_ROOT = "src/prompts/";

export const SHARED_DIR = "shared";

export const ROLE_ENTRY = "prompt";

export const PROMPT_ROLES = [
  "correctness",
  "security",
  "quality",
  "tests",
  "orchestrator",
  "ask",
  "triage",
  "verification",
  "description",
  "ci",
  "judge",
  "compaction",
];

export const PROMPT_SECTIONS = [
  "identity",
  "behavior",
  "safety",
  "tools",
  "communication",
  "output",
  "context",
  "examples",
  "repair",
];

export const OUTSIDE_IMPORTABLE_SHARED = [`${PROMPTS_ROOT}${SHARED_DIR}/safety.ts`];

export const INSIDE_IMPORTABLE_MODULES = [
  "src/settings/*Constants.ts",
  "src/settings/index.ts",
  "src/agent/codemode/guestCatalogue.ts",
  "src/util/escape.ts",
  "src/github/markdownFormat.ts",
];

export const TRANSITION_IMPORTS = [];

function globPattern(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

const INSIDE_IMPORTABLE_PATTERNS = INSIDE_IMPORTABLE_MODULES.map(globPattern);

function repoPath(context, file) {
  const rel = path.relative(context.cwd, file).split(path.sep).join("/");
  return rel.startsWith("../") || path.isAbsolute(rel) ? null : rel;
}

function promptParts(rel) {
  return rel.startsWith(PROMPTS_ROOT) ? rel.slice(PROMPTS_ROOT.length).split("/") : null;
}

function resolveSpecifier(context, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const absolute = path.resolve(path.dirname(context.filename), specifier);
  const rel = repoPath(context, absolute);
  if (rel == null) return null;
  return rel.endsWith(".js") ? `${rel.slice(0, -3)}.ts` : rel;
}

function isRoleEntry(target) {
  const parts = promptParts(target);
  return (
    parts != null &&
    parts.length === 2 &&
    PROMPT_ROLES.includes(parts[0]) &&
    parts[1] === `${ROLE_ENTRY}.ts`
  );
}

function transitionAllows(importer, target) {
  return TRANSITION_IMPORTS.some(
    (entry) => entry.importer === importer && entry.modules.includes(target),
  );
}

export const promptLayout = {
  meta: {
    type: "problem",
    messages: {
      depth: "Prompt modules live at src/prompts/<dir>/<file>.ts (ADR 0053).",
      dir: "'{{dir}}' is not a prompt directory. Use shared or a role: {{allowed}} (ADR 0053).",
      file: "'{{file}}' is not a prompt file name. Use a section or prompt.ts: {{allowed}} (ADR 0053).",
      sharedEntry: "shared/ holds section files only. prompt.ts belongs to a role (ADR 0053).",
    },
  },
  create(context) {
    return {
      Program(node) {
        const rel = repoPath(context, context.filename);
        const parts = rel == null ? null : promptParts(rel);
        if (parts == null) return;
        if (parts.length !== 2) {
          context.report({ node, messageId: "depth" });
          return;
        }
        const [dir, file] = parts;
        if (dir !== SHARED_DIR && !PROMPT_ROLES.includes(dir)) {
          context.report({
            node,
            messageId: "dir",
            data: { dir, allowed: [SHARED_DIR, ...PROMPT_ROLES].join(", ") },
          });
        }
        const stem = file.endsWith(".ts") ? file.slice(0, -3) : null;
        if (stem == null || (stem !== ROLE_ENTRY && !PROMPT_SECTIONS.includes(stem))) {
          context.report({
            node,
            messageId: "file",
            data: { file, allowed: [...PROMPT_SECTIONS, ROLE_ENTRY].join(", ") },
          });
        } else if (dir === SHARED_DIR && stem === ROLE_ENTRY) {
          context.report({ node, messageId: "sharedEntry" });
        }
      },
    };
  },
};

export const promptImports = {
  meta: {
    type: "problem",
    messages: {
      outside:
        "Outside src/prompts/, import only <role>/prompt.js or shared/safety.js, not '{{specifier}}' (ADR 0053).",
      inside:
        "Prompt modules import other prompt modules, types, or the allow-listed modules only, not '{{specifier}}' (ADR 0053).",
      sharedRole: "shared/ never imports a role directory: '{{specifier}}' (ADR 0053).",
    },
  },
  create(context) {
    const importer = repoPath(context, context.filename);
    if (importer == null || !importer.startsWith("src/")) return {};
    const importerParts = promptParts(importer);

    function checkOutside(node, specifier) {
      const target = resolveSpecifier(context, specifier);
      if (target == null || promptParts(target) == null) return;
      if (isRoleEntry(target) || OUTSIDE_IMPORTABLE_SHARED.includes(target)) return;
      if (transitionAllows(importer, target)) return;
      context.report({ node, messageId: "outside", data: { specifier } });
    }

    function checkInside(node, specifier, typeOnly) {
      const target = specifier == null ? null : resolveSpecifier(context, specifier);
      const targetParts = target == null ? null : promptParts(target);
      const shown = specifier ?? "<dynamic>";
      if (importerParts[0] === SHARED_DIR && targetParts != null && targetParts[0] !== SHARED_DIR) {
        context.report({ node, messageId: "sharedRole", data: { specifier: shown } });
        return;
      }
      if (typeOnly || targetParts != null) return;
      if (target != null && INSIDE_IMPORTABLE_PATTERNS.some((pattern) => pattern.test(target)))
        return;
      context.report({ node, messageId: "inside", data: { specifier: shown } });
    }

    function check(node, source, typeOnly) {
      const specifier =
        source?.type === "Literal" && typeof source.value === "string" ? source.value : null;
      if (importerParts != null) checkInside(node, specifier, typeOnly);
      else if (specifier != null) checkOutside(node, specifier);
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source, node.importKind === "type");
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source, node.exportKind === "type");
      },
      ExportAllDeclaration(node) {
        check(node, node.source, node.exportKind === "type");
      },
      ImportExpression(node) {
        check(node, node.source, false);
      },
    };
  },
};
