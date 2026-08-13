import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  create(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    const isInside = (target: ESTree.Node, ancestor: ESTree.Node): boolean => {
      let cur: ESTree.Node | null = target;
      while (cur !== null) {
        if (cur === ancestor) return true;
        cur = cur.parent;
      }
      return false;
    };

    const isDeclarationIdentifier = (node: ESTree.Identifier): boolean => {
      const parent = node.parent;
      if (parent === null) return false;
      if ((parent as unknown as Record<string, unknown>).id === node) return true;
      if (parent.type === "TSTypeParameter" && (parent as unknown as { name: ESTree.Identifier }).name === node) return true;
      if (
        parent.type === "ImportSpecifier" ||
        parent.type === "ImportDefaultSpecifier" ||
        parent.type === "ImportNamespaceSpecifier" ||
        parent.type === "ExportSpecifier"
      )
        return true;
      if ((parent as unknown as Record<string, unknown>).key === node) return true;
      if (parent.type === "AssignmentPattern" && parent.left === node) return true;
      if (parent.type === "RestElement" && parent.argument === node) return true;
      if (parent.type === "TSParameterProperty") return true;
      let cur: ESTree.Node | null = node;
      let curParent: ESTree.Node | null = parent;
      while (curParent !== null) {
        if (curParent.type === "VariableDeclarator" && isInside(cur, (curParent as ESTree.VariableDeclarator).id)) return true;
        if (
          curParent.type === "FunctionDeclaration" ||
          curParent.type === "FunctionExpression" ||
          curParent.type === "ArrowFunctionExpression" ||
          curParent.type === "TSEmptyBodyFunctionExpression" ||
          curParent.type === "TSDeclareFunction"
        ) {
          const params = (curParent as unknown as { params: ESTree.Node[] }).params;
          for (const param of params) if (isInside(node, param)) return true;
        }
        if (curParent.type === "CatchClause" && curParent.param !== null && isInside(node, curParent.param as ESTree.Node)) return true;
        if (
          (curParent.type === "ForInStatement" || curParent.type === "ForOfStatement") &&
          isInside(node, (curParent as unknown as { left: ESTree.Node }).left)
        )
          return true;
        if (
          curParent.type === "Property" &&
          curParent.parent?.type === "ObjectPattern" &&
          isInside(node, curParent.value as ESTree.Node)
        )
          return true;
        cur = curParent;
        curParent = curParent.parent;
        if (curParent?.type === "Program") break;
      }
      return false;
    };

    return {
      Identifier(node) {
        if (!isDeclarationIdentifier(node as ESTree.Identifier)) return;
        reportForbiddenSymbolName(node as ESTree.Node & { name: string });
      },
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
});
