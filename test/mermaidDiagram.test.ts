import { describe, expect, it } from "vitest";
import {
  extractMermaidDiagramBody,
  formatMermaidValidationError,
  repairMermaidNodeLabels,
  sanitizeMermaidDiagram,
  validateMermaidDiagram,
} from "../src/agent/description/mermaidDiagram.js";

describe("mermaidDiagram", () => {
  it("repairs slash-heavy labels that break GitHub", () => {
    const line = "  J[Admin Users List] --> K[/api/admin-users/list proxy]";
    const fixed = repairMermaidNodeLabels(line);
    expect(fixed).toContain('K["api/admin-users/list proxy"]');
    expect(fixed).not.toContain("[/api");
  });

  it("sanitizes fenced diagram from screenshot failure case", () => {
    const raw = [
      "```mermaid",
      "flowchart LR",
      "  A[Admin Form saves] --> B[useRenderRedirect]",
      "  J[Admin Users List] --> K[/api/admin-users/list proxy]",
      "  K --> L[Auth backend]",
      "```",
    ].join("\n");
    const out = sanitizeMermaidDiagram(raw);
    expect(out).toContain('K["api/admin-users/list proxy"]');
    expect(validateMermaidDiagram(out)).toEqual([]);
  });

  it("validates good quoted flowchart", () => {
    const raw = ["```mermaid", "flowchart LR", '  A["Start"] --> B["End"]', "```"].join("\n");
    expect(validateMermaidDiagram(raw)).toEqual([]);
  });

  it("rejects invalid diagram headers", () => {
    const raw = ["```mermaid", "sequenceDiagram", "  A->>B: Hi", "```"].join("\n");
    expect(validateMermaidDiagram(raw).length).toBeGreaterThan(0);
  });

  it("extracts diagram body without fence", () => {
    const body = extractMermaidDiagramBody("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(body).toBe("flowchart LR\n  A --> B");
  });

  it("formats validation errors for repair prompts", () => {
    const text = formatMermaidValidationError([
      { line: 3, message: "Slash in unquoted label breaks GitHub." },
    ]);
    expect(text).toContain("line 3");
    expect(text).toContain("omit changesDiagram");
  });
});
