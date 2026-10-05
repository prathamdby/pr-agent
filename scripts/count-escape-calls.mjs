import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

/** Count calls, including type arguments and import aliases, without counting the declaration. */
export function countEscapeCalls(root) {
  let count = 0;
  const api = new API();
  const config = path.join(path.dirname(root), "tsconfig.json");
  let snapshot;
  let project;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = project.program.getSourceFile(file);
      if (!source) throw new Error(`unparsed escape-call scope file ${file}`);
      const names = new Set(["escape"]);
      const namespaces = new Set();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        if (!statement.moduleSpecifier.text.endsWith("/escape.js")) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            if ((binding.propertyName ?? binding.name).text === "escape")
              names.add(binding.name.text);
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          namespaces.add(bindings.name.text);
        }
      }
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          let callee = node.expression;
          while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
          if (
            (ts.isIdentifier(callee) && names.has(callee.text)) ||
            (ts.isPropertyAccessExpression(callee) &&
              callee.name.text === "escape" &&
              ts.isIdentifier(callee.expression) &&
              namespaces.has(callee.expression.text)) ||
            (ts.isElementAccessExpression(callee) &&
              ts.isStringLiteral(callee.argumentExpression) &&
              callee.argumentExpression.text === "escape" &&
              ts.isIdentifier(callee.expression) &&
              namespaces.has(callee.expression.text))
          )
            count += 1;
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
  };
  try {
    snapshot = api.updateSnapshot({ openProjects: [config] });
    project = snapshot.getProject(config);
    if (!project) throw new Error(`missing TypeScript project for ${root}`);
    walk(root);
    return count;
  } finally {
    snapshot?.dispose();
    api.close();
  }
}
