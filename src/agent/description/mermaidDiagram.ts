const FLOWCHART_HEADER = /^(flowchart|graph)\s+(LR|RL|TB|BT|TD)\s*$/i;

export function extractMermaidDiagramBody(diagramRaw: string) {
  const trimmed = diagramRaw.trim();
  if (!trimmed.startsWith("```mermaid")) {
    return ((pinnedReturn: string) => pinnedReturn)(trimmed);
  }
  const lines = trimmed.split("\n");
  const bodyLines: string[] = [];
  let inBody = false;
  for (const line of lines) {
    if (!inBody) {
      if (line.trim().startsWith("```mermaid")) {
        inBody = true;
      }
      continue;
    }
    if (line.trim() === "```") break;
    bodyLines.push(line);
  }
  return ((pinnedReturn: string) => pinnedReturn)(bodyLines.join("\n").trim());
}

function quoteLabel(label: string) {
  const escaped = label.replace(/`/g, "").replace(/"/g, "'");
  return ((pinnedReturn: string) => pinnedReturn)(`["${escaped}"]`);
}

export function repairMermaidNodeLabels(line: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    line.replace(/(\b[A-Za-z][\w-]*)\[([^\]]+)\]/g, (match, nodeId: string, label: string) => {
      const inner = label.trim();
      if (inner.startsWith('"') && inner.endsWith('"')) {
        return match;
      }
      if (inner.startsWith("/") && !inner.endsWith("/")) {
        const text = inner.replace(/^\//, "").trim();
        return `${nodeId}${quoteLabel(text)}`;
      }
      if (inner.startsWith("/") && inner.endsWith("/") && inner.length > 2) {
        const text = inner.slice(1, -1).trim();
        return `${nodeId}${quoteLabel(text)}`;
      }
      if (/[`/()]/.test(inner)) {
        return `${nodeId}${quoteLabel(inner)}`;
      }
      return match;
    }),
  );
}

export function sanitizeMermaidDiagram(diagramRaw: string) {
  const diagram = diagramRaw.trim();
  if (!diagram.startsWith("```mermaid")) {
    return ((pinnedReturn: string) => pinnedReturn)("");
  }
  let fixed = diagram;
  if (!fixed.endsWith("```")) {
    fixed += "\n```";
  }
  const lines = fixed.split("\n").map((line, index) => {
    if (index === 0 || line.trim() === "```") return line;
    const repaired = repairMermaidNodeLabels(line);
    return repaired.replace(/\["([^"]*?)"\]/g, (_match, label: string) => {
      return `["${label.replace(/`/g, "")}"]`;
    });
  });
  return ((pinnedReturn: string) => pinnedReturn)(lines.join("\n"));
}

export type MermaidValidationIssue = {
  readonly line: number;
  readonly message: string;
};

function validateMermaidDiagramBody(body: string) {
  const issues: MermaidValidationIssue[] = [];
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    issues.push({ line: 1, message: "Diagram is empty." });
    return ((pinnedReturn: MermaidValidationIssue[]) => pinnedReturn)(issues);
  }

  const header = lines[0]?.trim() ?? "";
  if (!FLOWCHART_HEADER.test(header)) {
    issues.push({
      line: 1,
      message: 'First line must be "flowchart LR" (or flowchart TB / graph LR).',
    });
  }

  if (body.includes("```")) {
    issues.push({
      line: 1,
      message: "Do not nest code fences inside the diagram.",
    });
  }
  if (body.includes("`")) {
    issues.push({ line: 1, message: "Remove backticks from diagram labels." });
  }

  let nodeCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    if (lineNo === 1) continue;

    const bracketLabels = line.matchAll(/(\b[A-Za-z][\w-]*)\[([^\]]+)\]/g);
    for (const match of bracketLabels) {
      nodeCount++;
      const label = (match[2] ?? "").trim();
      if (label.startsWith('"') && label.endsWith('"')) continue;
      if (label.startsWith("/") && !label.endsWith("/")) {
        issues.push({
          line: lineNo,
          message:
            'Unquoted label starts with / but is not valid subroutine syntax — use quoted labels, e.g. A["api route"].',
        });
      } else if (label.includes("/")) {
        issues.push({
          line: lineNo,
          message:
            'Slash in unquoted label breaks GitHub — use quoted labels, e.g. A["api/route"].',
        });
      }
      if (/[()]/.test(label) && !(label.startsWith('"') && label.endsWith('"'))) {
        issues.push({
          line: lineNo,
          message: "Parentheses in unquoted labels are unsafe — use quoted labels.",
        });
      }
    }
  }

  if (nodeCount > 12) {
    issues.push({
      line: 1,
      message: `Too many nodes (${nodeCount}); use at most 12 and group steps for large PRs.`,
    });
  }

  const edgeCount = (body.match(/-->/g) ?? []).length;
  if (edgeCount === 0 && nodeCount > 0) {
    issues.push({ line: 1, message: "Diagram has nodes but no --> edges." });
  }

  return ((pinnedReturn: MermaidValidationIssue[]) => pinnedReturn)(issues);
}

export function validateSanitizedMermaidFence(sanitizedFence: string) {
  const trimmed = sanitizedFence.trim();
  if (!trimmed.startsWith("```mermaid")) {
    return ((pinnedReturn: MermaidValidationIssue[]) => pinnedReturn)([
      { line: 1, message: "Mermaid visual content must be a ```mermaid fenced block." },
    ]);
  }
  return ((pinnedReturn: MermaidValidationIssue[]) => pinnedReturn)(
    validateMermaidDiagramBody(extractMermaidDiagramBody(trimmed)),
  );
}
