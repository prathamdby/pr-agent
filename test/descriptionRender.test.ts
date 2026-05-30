import { describe, expect, it } from "vitest";
import {
  renderDescriptionAgentBlock,
  sanitizeMermaidDiagram,
} from "../src/agent/descriptionRender.js";
import { DESCRIPTION_AGENT_HEADER } from "../src/settings/index.js";

describe("descriptionRender", () => {
  it("sanitizes mermaid fences", () => {
    const raw = '```mermaid\nflowchart LR\n  A["`x`"] --> B["y"]\n';
    const out = sanitizeMermaidDiagram(raw);
    expect(out.endsWith("```")).toBe(true);
    expect(out).not.toContain("`x`");
  });

  it("renders agent block with header and type", () => {
    const body = renderDescriptionAgentBlock({
      title: "ignored in render",
      type: ["Enhancement"],
      description: "- Main change",
    });
    expect(body.startsWith(DESCRIPTION_AGENT_HEADER)).toBe(true);
    expect(body).toContain("### PR Type");
    expect(body).toContain("Enhancement");
  });
});
