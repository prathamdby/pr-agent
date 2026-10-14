const SUPPRESSION = /^ oxlint-disable-next-line [\w@/-]+(?:, [\w@/-]+)* -- \S/;
const REFERENCE = /^\/\s*<reference\s/;

function isMachineDirective(comment) {
  return (
    comment.type === "Line" && (SUPPRESSION.test(comment.value) || REFERENCE.test(comment.value))
  );
}

function wholeLineRange(text, start, end) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline === -1 ? text.length : newline;
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (before.trim() !== "" || after.trim() !== "") return null;
  return [lineStart, newline === -1 ? lineEnd : newline + 1];
}

function removal(text, comment) {
  const line = wholeLineRange(text, comment.start, comment.end);
  if (line) return { range: line, replacement: "" };
  const holdsLineBreak = comment.type === "Block" && comment.value.includes("\n");
  return { range: [comment.start, comment.end], replacement: holdsLineBreak ? "\n" : "" };
}

const noComments = {
  meta: {
    type: "suggestion",
    fixable: "code",
    messages: {
      comment:
        "Source carries no comments. Encode the constraint in a name, type, guard, test, or ADR (ADR 0051).",
    },
  },
  create(context) {
    const emptyJsxContainers = [];
    return {
      JSXExpressionContainer(node) {
        if (node.expression.type === "JSXEmptyExpression") emptyJsxContainers.push(node);
      },
      "Program:exit"() {
        const text = context.sourceCode.text;
        const runs = [];
        for (const comment of context.sourceCode.getAllComments()) {
          if (isMachineDirective(comment)) continue;
          const container = emptyJsxContainers.find(
            (node) => node.start <= comment.start && comment.end <= node.end,
          );
          const edit = container
            ? { range: [container.start, container.end], replacement: "" }
            : removal(text, comment);
          const last = runs.at(-1);
          if (last && edit.range[0] <= last.range[1]) {
            if (edit.range[1] > last.range[1]) {
              last.replacement += text.slice(last.range[1], edit.range[0]) + edit.replacement;
              last.range[1] = edit.range[1];
            }
            last.comments.push(comment);
          } else {
            runs.push({ ...edit, comments: [comment] });
          }
        }
        for (const run of runs) {
          const [first, ...rest] = run.comments;
          context.report({
            loc: first.loc,
            messageId: "comment",
            fix: (fixer) => fixer.replaceTextRange(run.range, run.replacement),
          });
          for (const comment of rest) context.report({ loc: comment.loc, messageId: "comment" });
        }
      },
    };
  },
};

export default {
  meta: { name: "pr-agent" },
  rules: { "no-comments": noComments },
};
