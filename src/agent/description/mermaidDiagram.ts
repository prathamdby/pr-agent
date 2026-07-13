const FLOWCHART_HEADER = /^(flowchart|graph)\s+(LR|RL|TB|BT|TD)\s*$/i;

/** Extract diagram body from a fenced ```mermaid block (or return trimmed raw). */
export function extractMermaidDiagramBody(diagramRaw: string): string {
  const trimmed = diagramRaw.trim();
  if (!trimmed.startsWith("```mermaid")) {
    return trimmed;
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
  return bodyLines.join("\n").trim();
}

function quoteLabel(label: string): string {
  const escaped = label.replace(/`/g, "").replace(/"/g, "'");
  return `["${escaped}"]`;
}

/** Fix common model mistakes so GitHub's Mermaid lexer accepts the diagram. */
export function repairMermaidNodeLabels(line: string): string {
  return line.replace(/(\b[A-Za-z][\w-]*)\[([^\]]+)\]/g, (match, nodeId: string, label: string) => {
    const inner = label.trim();
    if (inner.startsWith('"') && inner.endsWith('"')) {
      return match;
    }
    // Broken subroutine: [/path/like text] without a closing slash before ]
    if (inner.startsWith("/") && !inner.endsWith("/")) {
      const text = inner.replace(/^\//, "").trim();
      return `${nodeId}${quoteLabel(text)}`;
    }
    // Valid subroutine [/text/]: convert to quoted (slashes break GitHub on paths)
    if (inner.startsWith("/") && inner.endsWith("/") && inner.length > 2) {
      const text = inner.slice(1, -1).trim();
      return `${nodeId}${quoteLabel(text)}`;
    }
    if (/[`/()]/.test(inner)) {
      return `${nodeId}${quoteLabel(inner)}`;
    }
    return match;
  });
}

export function sanitizeMermaidDiagram(diagramRaw: string): string {
  const diagram = diagramRaw.trim();
  if (!diagram.startsWith("```mermaid")) {
    return "";
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
  return lines.join("\n");
}

export type MermaidValidationIssue = {
  readonly line: number;
  readonly message: string;
};

function validateMermaidDiagramBody(body: string): MermaidValidationIssue[] {
  const issues: MermaidValidationIssue[] = [];
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    issues.push({ line: 1, message: "Diagram is empty." });
    return issues;
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
            'Unquoted label starts with / but is not valid subroutine syntax. Use quoted labels, e.g. A["api route"].',
        });
      } else if (label.includes("/")) {
        issues.push({
          line: lineNo,
          message:
            'Slash in unquoted label breaks GitHub. Use quoted labels, e.g. A["api/route"].',
        });
      }
      if (/[()]/.test(label) && !(label.startsWith('"') && label.endsWith('"'))) {
        issues.push({
          line: lineNo,
          message: "Parentheses in unquoted labels are unsafe. Use quoted labels.",
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

  return issues;
}

export function validateSanitizedMermaidFence(sanitizedFence: string): MermaidValidationIssue[] {
  const trimmed = sanitizedFence.trim();
  if (!trimmed.startsWith("```mermaid")) {
    return [{ line: 1, message: "changesDiagram must be a ```mermaid fenced block." }];
  }
  return validateMermaidDiagramBody(extractMermaidDiagramBody(trimmed));
}

export function validateMermaidDiagram(diagramRaw: string): MermaidValidationIssue[] {
  const trimmed = diagramRaw.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("```mermaid")) {
    return [{ line: 1, message: "changesDiagram must be a ```mermaid fenced block." }];
  }
  return validateSanitizedMermaidFence(sanitizeMermaidDiagram(trimmed));
}

export function formatMermaidValidationError(issues: readonly MermaidValidationIssue[]): string {
  const lines = issues.map((issue) => `- line ${issue.line}: ${issue.message}`);
  return [
    "changesDiagram Mermaid validation failed:",
    ...lines,
    "",
    "Fix the diagram (quoted labels, no /subroutine/ shapes, one connected flowchart LR) or omit changesDiagram.",
  ].join("\n");
}
