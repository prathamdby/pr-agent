import path from "node:path";

export const ACRONYMS = [
  "AI",
  "API",
  "ASD-STE100",
  "CDN",
  "CI",
  "CSRF",
  "DB",
  "HTML",
  "HTTP",
  "IAM",
  "ID",
  "IDOR",
  "JS/TS",
  "JSON",
  "JWT",
  "LLM",
  "PR",
  "RBAC",
  "RCE",
  "SHA",
  "SQL",
  "SQL/JSON",
  "SQL/XSS",
  "SSRF",
  "TOCTOU",
  "UI",
  "URL",
  "UTF-8",
  "WAF",
  "XSS",
];

export const ENUMS_AND_IDENTIFIERS = [
  "AGENTS",
  "AND",
  "OR",
  "AND/OR",
  "CLAUDE",
  "CRITICAL",
  "GET",
  "HEAD",
  "HIGH",
  "LR",
  "MEDIUM",
  "P0",
  "P0/P1",
  "P1",
  "P2",
  "P3",
  "SEARCH_TRUNCATED",
  "TB",
  "TODO",
  "XL",
  "XS",
  "XXL",
];

export const PRESSURE_WORDS = ["MUST", "NEVER", "ALWAYS", "CRITICAL", "IMPORTANT"];

export const KEEP_LIST_EXPORTS = [
  "FINDING_ANTI_SUPPRESSION",
  "userSupplementGuidance",
  "specialistUntrustedEvidenceGuidance",
  "repoPolicyGuidance",
  "agentInstructionFilesGuidance",
  "context7OutboundDataGuidance",
  "wrapUntrustedBlock",
  "wrapUntrustedEvidence",
  "wrapTrustedContext",
  "renderRepoPolicyBlock",
  "renderAgentInstructionFilesBlock",
];

const acronyms = new Set(ACRONYMS);
const contextualTokens = new Set(ENUMS_AND_IDENTIFIERS);
const pressureWords = new Set(PRESSURE_WORDS);
const keepList = new Set(KEEP_LIST_EXPORTS);

function children(node) {
  return Object.entries(node).flatMap(([key, value]) => {
    if (
      ["parent", "id", "typeAnnotation", "typeParameters", "returnType"].includes(key) ||
      (key === "key" && !node.computed) ||
      (key === "property" && !node.computed) ||
      key === "source" ||
      (node.type.startsWith("TS") &&
        !["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node.type))
    )
      return [];
    return (Array.isArray(value) ? value : [value]).filter(
      (child) => child != null && typeof child.type === "string",
    );
  });
}

function exportedRoots(program) {
  return program.body.flatMap((node) => {
    if (node.type === "ExportDefaultDeclaration")
      return [{ name: "default", node: node.declaration }];
    if (node.type !== "ExportNamedDeclaration" || node.exportKind === "type" || node.source)
      return [];
    if (node.declaration?.type === "VariableDeclaration")
      return node.declaration.declarations.map((declaration) => ({
        name: declaration.id.name,
        node: declaration.init,
      }));
    if (node.declaration?.type === "FunctionDeclaration")
      return [{ name: node.declaration.id.name, node: node.declaration }];
    return node.specifiers
      .filter((specifier) => specifier.exportKind !== "type")
      .map((specifier) => ({
        name: specifier.exported.name ?? specifier.exported.value,
        node: specifier.local,
      }));
  });
}

function allowedToken(token, line, index) {
  if (acronyms.has(token)) return true;
  if (!contextualTokens.has(token)) return false;
  if (/^(?:P[0-3](?:\/P[0-3])?|AND|OR|AND\/OR)$/.test(token)) return true;
  if (["CRITICAL", "HIGH", "MEDIUM"].includes(token)) {
    const prefix = line
      .slice(0, index)
      .split(/[.!?;]/)
      .at(-1)
      .match(/\b(?:severity|enum)\s+(?:values|names)\b(.*)$/i)?.[1];
    return (
      prefix != null &&
      /^(?:\s|[:,|/()`"'=-]|\b(?:are|include|and|or|never|not|CRITICAL|HIGH|MEDIUM|P[0-3])\b)*$/.test(
        prefix,
      )
    );
  }
  const before = line[index - 1];
  const after = line[index + token.length];
  if (["`", "'", '"'].includes(before) && after === before) return true;
  if (["AGENTS", "CLAUDE"].includes(token))
    return line.slice(index + token.length).startsWith(".md");
  if (token === "GET") return /^\s+\//.test(line.slice(index + token.length));
  if (token === "HEAD") return /\b(?:git|commit|checkout|branch|revision)\b/i.test(line);
  if (["LR", "TB"].includes(token)) return /\b(?:flowchart|graph)\b/.test(line);
  if (["XS", "XL", "XXL"].includes(token)) return /\b(?:size|scale)\b/i.test(line);
  return false;
}

function literalText(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateElement") return node.value.cooked ?? node.value.raw;
  return null;
}

function exemptLiteral(node, text) {
  if (/^\s*<\/?[A-Za-z_][\w:-]*(?:\s+[^>]*)?\/?>\s*$/.test(text)) return true;
  if (node.parent?.type === "NewExpression" || node.parent?.type === "CallExpression") {
    const call = node.parent;
    if (call.callee.type === "Identifier" && call.callee.name === "RegExp")
      return call.arguments[1] === node;
    if (
      call.callee.type === "Identifier" &&
      ["wrapUntrustedBlock", "neutralizeUntrustedBlockTags"].includes(call.callee.name)
    )
      return call.arguments[0] === node && /^[A-Za-z_][\w:-]*$/.test(text);
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    messages: {
      caps: "Use sentence case, not '{{word}}' for emphasis (ADR 0053).",
      pressure: "State the rule once with its reason, not '{{word}}' for emphasis (ADR 0053).",
      exclamation: "End the sentence without an exclamation mark (ADR 0053).",
    },
  },
  create(context) {
    const file = path.relative(context.cwd, context.filename).split(path.sep).join("/");
    const prompt = file.startsWith("src/prompts/");
    const tool =
      file.startsWith("src/") &&
      (file.startsWith("src/agent/tools/") || /(?:Tool|Tools|Toolset|Schema)\.ts$/.test(file));
    const catalogue = file === "src/agent/codemode/guestCatalogue.ts";
    if (!prompt && !tool && !catalogue) return {};

    function definition(identifier) {
      for (
        let scope = context.sourceCode.getScope(identifier);
        scope != null;
        scope = scope.upper
      ) {
        const variable = scope.set.get(identifier.name);
        if (!variable) continue;
        return variable.defs
          .filter((def) => def.type === "Variable" || def.type === "FunctionName")
          .map((def) => (def.node.type === "VariableDeclarator" ? def.node.init : def.node));
      }
      return [];
    }

    function collect(root, found, visited) {
      if (root == null || visited.has(root)) return;
      visited.add(root);
      if (literalText(root) != null) found.add(root);
      if (root.type === "Identifier")
        for (const node of definition(root)) collect(node, found, visited);
      for (const child of children(root)) collect(child, found, visited);
    }

    function check(node) {
      const text = literalText(node);
      if (exemptLiteral(node, text)) return;
      for (const line of text.split("\n")) {
        if (/^\s*(?:- )?`?[a-z][\w.[\]]*`?(?:\s*\([^)]*\))?:/.test(line)) continue;
        for (const match of line.matchAll(/\b[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*\b/g)) {
          const word = match[0];
          if (word.length < 2 || allowedToken(word, line, match.index)) continue;
          context.report({
            node,
            messageId: pressureWords.has(word) ? "pressure" : "caps",
            data: { word },
          });
        }
        for (const match of line.matchAll(/\bunder no circumstances\b/gi))
          context.report({ node, messageId: "pressure", data: { word: match[0] } });
        line
          .match(/[A-Za-z0-9)\]'"`]!(?=["'`)\]]*(?:\s|$))/g)
          ?.forEach(() => context.report({ node, messageId: "exclamation" }));
      }
    }

    return {
      Program(program) {
        const roots = exportedRoots(program);
        const frozen = new Set();
        const literals = new Set();
        const visited = new Set();
        if (prompt) {
          for (const root of roots)
            if (keepList.has(root.name)) collect(root.node, frozen, new Set());
          for (const root of roots)
            if (!keepList.has(root.name)) collect(root.node, literals, visited);
        } else if (catalogue) {
          for (const root of roots)
            if (root.name === "renderExecuteDescription") collect(root.node, literals, visited);
        } else {
          const pending = [program];
          while (pending.length > 0) {
            const node = pending.pop();
            if (node.type === "Property" && (node.key.name ?? node.key.value) === "description")
              collect(node.value, literals, visited);
            if (
              node.type === "CallExpression" &&
              node.callee.type === "MemberExpression" &&
              node.callee.object.name === "v" &&
              (node.callee.property.name ?? node.callee.property.value) === "description"
            )
              collect(node.arguments[0], literals, visited);
            pending.push(...children(node));
          }
        }
        for (const literal of literals) if (!frozen.has(literal)) check(literal);
      },
    };
  },
};
