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

export const PROMPT_SEND_RECEIVERS = ["session", "activeSession"];

export const PROMPT_CALL_ARGUMENTS = {
  sendWithRetry: 1,
  runSubmitOnlyRound: 1,
  send: 1,
};

export const PROMPT_WRAPPERS = {
  ...PROMPT_CALL_ARGUMENTS,
  defaultSubmitOnlySend: 1,
  createFeaturePiSession: 0,
  runFeatureAgent: 0,
};

export const PROMPT_FIELDS = ["systemPrompt", "userContent", "nudge", "repairPrompt"];

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

function childNodes(node) {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === "parent" || key === "typeAnnotation" || key === "typeParameters") return [];
    const values = Array.isArray(value) ? value : [value];
    return values.filter((child) => child != null && typeof child.type === "string");
  });
}

function propertyName(node) {
  if (node.computed && node.key?.type !== "Literal") return null;
  return node.key?.name ?? node.key?.value ?? node.property?.name ?? null;
}

function functionName(node) {
  return node.id?.name ?? node.parent?.id?.name ?? null;
}

function expression(node) {
  while (
    node &&
    ["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TSNonNullExpression"].includes(
      node.type,
    )
  )
    node = node.expression;
  return node;
}

export const promptSinks = {
  meta: {
    type: "problem",
    messages: {
      origin:
        "Prompt sinks accept src/prompts/ exports, const expressions with checked origins, or checked prompt carriers only (ADR 0053).",
      literal: "Prompt text belongs under src/prompts/, not in a sink argument (ADR 0053).",
      reassignment: "Do not reassign a prompt parameter inside a sink wrapper (ADR 0053).",
    },
  },
  create(context) {
    const file = repoPath(context, context.filename);
    if (file == null || !file.startsWith("src/") || promptParts(file) != null) return {};
    const checkedMaps = new Set();
    const resolvingConstants = new Set();

    function variable(identifier) {
      for (
        let scope = context.sourceCode.getScope(identifier);
        scope != null;
        scope = scope.upper
      ) {
        const found = scope.set.get(identifier.name);
        if (found) return found;
      }
      return null;
    }

    function importedPrompt(identifier) {
      return variable(identifier)?.defs.some((def) => {
        if (def.type !== "ImportBinding" || def.parent.importKind === "type") return false;
        if (def.node.importKind === "type") return false;
        const target = resolveSpecifier(context, def.parent.source.value);
        return target != null && promptParts(target) != null;
      });
    }

    function promptExport(node) {
      if (node.type === "Identifier") return importedPrompt(node);
      return (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.object.type === "Identifier" &&
        importedPrompt(node.object)
      );
    }

    function promptParameter(identifier) {
      return variable(identifier)?.defs.some(
        (def) =>
          def.type === "Parameter" &&
          Object.hasOwn(PROMPT_WRAPPERS, functionName(def.node)) &&
          def.node.params[PROMPT_WRAPPERS[functionName(def.node)]] === def.name,
      );
    }

    function constResult(identifier) {
      const def = variable(identifier)?.defs.find(
        (entry) =>
          entry.type === "Variable" && entry.parent.kind === "const" && entry.node.init != null,
      );
      if (!def || resolvingConstants.has(def)) return false;
      resolvingConstants.add(def);
      const bad = literal(def.node.init) ?? invalid(def.node.init);
      resolvingConstants.delete(def);
      return bad == null;
    }

    function literal(node) {
      if (node.type === "ConditionalExpression")
        return literal(node.consequent) ?? literal(node.alternate);
      if (
        node.type === "TemplateLiteral" ||
        (node.type === "Literal" && typeof node.value === "string")
      )
        return node;
      for (const child of childNodes(node)) {
        const found = literal(child);
        if (found) return found;
      }
      return null;
    }

    function promptMap(node) {
      if (node.type !== "Identifier") return false;
      const binding = variable(node);
      const def = binding?.defs.find(
        (entry) =>
          entry.type === "Variable" &&
          entry.parent.kind === "const" &&
          expression(entry.node.init)?.type === "ObjectExpression",
      );
      if (!def || !["module", "global"].includes(binding.scope.type)) return false;
      const object = expression(def.node.init);
      if (!checkedMaps.has(object)) {
        checkedMaps.add(object);
        for (const property of object.properties) {
          if (property.type === "Property") check(property.value);
          else context.report({ node: property, messageId: "origin" });
        }
      }
      return true;
    }

    function invalid(node, runtime = false) {
      node = expression(node);
      if (node.type === "ConditionalExpression")
        return invalid(node.consequent, runtime) ?? invalid(node.alternate, runtime);
      if (node.type === "Identifier") {
        return runtime || importedPrompt(node) || promptParameter(node) || constResult(node)
          ? null
          : node;
      }
      if (node.type === "MemberExpression") {
        if (!node.computed && PROMPT_FIELDS.includes(propertyName(node))) return null;
        if (node.computed && promptMap(node.object)) return invalid(node.property, true);
        return (
          invalid(node.object, runtime) ?? (node.computed ? invalid(node.property, runtime) : null)
        );
      }
      if (node.type === "CallExpression") {
        const promptCall =
          promptExport(node.callee) ||
          (node.callee.type === "MemberExpression" &&
            !node.callee.computed &&
            propertyName(node.callee) === "repairPrompt");
        const badCallee = invalid(node.callee, runtime);
        if (badCallee) return badCallee;
        for (const argument of node.arguments) {
          const found = invalid(argument, runtime || promptCall);
          if (found) return found;
        }
        return null;
      }
      if (node.type === "Property") {
        return (node.computed ? invalid(node.key, runtime) : null) ?? invalid(node.value, runtime);
      }
      if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
        const body = node.body;
        if (runtime) return invalid(body, true);
        if (body.type === "CallExpression" && promptExport(body.callee)) return invalid(body);
        if (
          body.type === "BlockStatement" &&
          body.body.length === 1 &&
          body.body[0].type === "ReturnStatement" &&
          body.body[0].argument?.type === "CallExpression" &&
          promptExport(body.body[0].argument.callee)
        )
          return invalid(body.body[0].argument);
        return node;
      }
      for (const child of childNodes(node)) {
        const found = invalid(child, runtime);
        if (found) return found;
      }
      return null;
    }

    function check(node) {
      let runtime = false;
      for (let current = node; current.parent; current = current.parent) {
        if (
          current.parent.type === "CallExpression" &&
          current.parent.arguments.includes(current) &&
          promptExport(current.parent.callee)
        ) {
          runtime = true;
          break;
        }
      }
      const text = literal(node);
      const bad = text ?? invalid(node, runtime);
      if (bad) context.report({ node: bad, messageId: text ? "literal" : "origin" });
    }

    function fields(node, name, visit) {
      if (node.type === "Property" && propertyName(node) === name) visit(node.value);
      else for (const child of childNodes(node)) fields(child, name, visit);
    }

    function reassignment(node, target) {
      if (target.type === "Identifier") {
        if (promptParameter(target)) context.report({ node, messageId: "reassignment" });
      } else if (target.type === "MemberExpression") {
        if (
          !target.computed &&
          PROMPT_FIELDS.includes(propertyName(target)) &&
          target.object.type === "Identifier" &&
          promptParameter(target.object)
        )
          context.report({ node, messageId: "reassignment" });
      } else if (target.type === "Property") {
        reassignment(node, target.value);
      } else {
        for (const child of childNodes(target)) reassignment(node, child);
      }
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.name === "send" &&
          callee.object.type === "Identifier" &&
          PROMPT_SEND_RECEIVERS.includes(callee.object.name)
        ) {
          if (node.arguments[0]) check(node.arguments[0]);
        } else if (
          callee.type === "Identifier" &&
          Object.hasOwn(PROMPT_CALL_ARGUMENTS, callee.name)
        ) {
          const prompt = node.arguments[PROMPT_CALL_ARGUMENTS[callee.name]];
          if (prompt) check(prompt);
        } else if (callee.type === "Identifier" && callee.name === "streamFn") {
          if (node.arguments[1])
            fields(node.arguments[1], "messages", (messages) =>
              fields(messages, "content", (content) => fields(content, "text", check)),
            );
        }
      },
      Property(node) {
        if (PROMPT_FIELDS.includes(propertyName(node))) check(node.value);
      },
      AssignmentExpression(node) {
        reassignment(node, node.left);
      },
      UpdateExpression(node) {
        reassignment(node, node.argument);
      },
    };
  },
};
