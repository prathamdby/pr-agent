import { describe, expect, it } from "vitest";
import {
  renderDescriptionAgentBlock,
  sanitizeMermaidDiagram,
} from "../src/agent/descriptionRender.js";
import { DESCRIPTION_AGENT_HEADER } from "../src/settings/index.js";

const RENDER_CTX = { owner: "acme", repo: "widgets", prNumber: 42 };

describe("descriptionRender", () => {
  it("sanitizes mermaid fences", () => {
    const raw = '```mermaid\nflowchart LR\n  A["`x`"] --> B["y"]\n';
    const out = sanitizeMermaidDiagram(raw);
    expect(out.endsWith("```")).toBe(true);
    expect(out).not.toContain("`x`");
  });

  it("renders agent block with header and type", () => {
    const body = renderDescriptionAgentBlock(
      {
        title: "ignored in render",
        type: ["Enhancement"],
        description: "- Main change",
      },
      RENDER_CTX,
    );
    expect(body.startsWith(DESCRIPTION_AGENT_HEADER)).toBe(true);
    expect(body).toContain("### PR Type");
    expect(body).toContain("Enhancement");
  });

  it("renders file walkthrough as nested accordions", () => {
    const body = renderDescriptionAgentBlock(
      {
        title: "t",
        type: ["Enhancement"],
        description: "- Main",
        prFiles: [
          {
            filename: "src/a.ts",
            changesTitle: "New render-safe redirect hook",
            changesSummary: "- Uses state redirect",
            label: "enhancement",
          },
          {
            filename: "src/b.ts",
            changesTitle: "Admin users list API proxy",
            changesSummary: "- Proxies auth backend",
            label: "enhancement",
          },
        ],
      },
      RENDER_CTX,
    );
    expect(body).toContain("### File Walkthrough");
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>Enhancement (2 files)</summary>");
    expect(body).toContain("<summary>New render-safe redirect hook</summary>");
    expect(body).toContain(
      '<a href="https://github.com/acme/widgets/pull/42/files#diff-',
    );
    expect(body).toContain("<code>src/a.ts</code></a>");
    expect(body).not.toContain("`src/a.ts`");
    expect(body).not.toMatch(/^- `src\/a\.ts`/m);
  });

  it("linkifies unique basenames in walkthrough bullets", () => {
    const body = renderDescriptionAgentBlock(
      {
        title: "t",
        type: ["Enhancement"],
        description: "- Main",
        prFiles: [
          {
            filename: "src/agentWork/intake/planner.ts",
            changesTitle: "Intake sub-system decomposed",
            changesSummary: "- `planner.ts`: pure function mapping action to work kinds",
            label: "enhancement",
          },
        ],
      },
      RENDER_CTX,
    );
    expect(body).toContain("[planner.ts](https://github.com/acme/widgets/pull/42/files#diff-");
    expect(body).not.toContain("`- planner.ts`");
  });

  it("does not linkify ambiguous basenames shared by three files", () => {
    const body = renderDescriptionAgentBlock(
      {
        title: "t",
        type: ["Enhancement"],
        description: "- Main",
        prFiles: [
          {
            filename: "src/a/index.ts",
            changesTitle: "A",
            changesSummary: "- `index.ts`: a",
            label: "enhancement",
          },
          {
            filename: "src/b/index.ts",
            changesTitle: "B",
            changesSummary: "- `index.ts`: b",
            label: "enhancement",
          },
          {
            filename: "src/c/index.ts",
            changesTitle: "C",
            changesSummary: "- `index.ts`: c",
            label: "enhancement",
          },
        ],
      },
      RENDER_CTX,
    );
    expect(body).toContain("- `index.ts`:");
    expect(body).not.toMatch(/\[index\.ts\]\(https:\/\/github\.com/);
  });
});
