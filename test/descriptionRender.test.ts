import { describe, expect, it } from "vitest";
import {
  prBodyHasDescriptionReviewMap,
  renderDescriptionAgentBlock,
  sanitizeMermaidDiagram,
} from "../src/agent/description/descriptionRender.js";
import {
  DESCRIPTION_AGENT_HEADER,
  DESCRIPTION_REVIEW_MAP_HEADING,
} from "../src/settings/index.js";

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
    expect(body).not.toContain(DESCRIPTION_REVIEW_MAP_HEADING);
  });

  it("omits review map section when prFiles is empty or absent", () => {
    const body = renderDescriptionAgentBlock(
      {
        title: "t",
        type: ["Enhancement"],
        description: "- Main",
        prFiles: [],
      },
      RENDER_CTX,
    );
    expect(body).not.toContain(DESCRIPTION_REVIEW_MAP_HEADING);
    expect(body).not.toContain("<details>");
  });

  it("renders read-first map as a flat ordered list with diff links", () => {
    const body = renderDescriptionAgentBlock(
      {
        title: "t",
        type: ["Enhancement"],
        description: "- Main",
        prFiles: [
          {
            filename: "src/a.ts",
            changesTitle: "Auth boundary risk",
          },
          {
            filename: "src/b.ts",
            changesTitle: "Data path for the new flow",
          },
        ],
      },
      RENDER_CTX,
    );
    expect(body).toContain(DESCRIPTION_REVIEW_MAP_HEADING);
    expect(body).toContain("1. [`src/a.ts`](https://github.com/acme/widgets/pull/42/files#diff-");
    expect(body).toContain("): Auth boundary risk");
    expect(body).toContain("2. [`src/b.ts`](https://github.com/acme/widgets/pull/42/files#diff-");
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("<summary>");
    expect(body).not.toContain("File Walkthrough");
  });

  it("ignores legacy label and changesSummary in map render", () => {
    const body = renderDescriptionAgentBlock(
      {
        title: "t",
        type: ["Enhancement"],
        description: "- Main",
        prFiles: [
          {
            filename: "src/agentWork/intake/planner.ts",
            changesTitle: "Intake mapping is the core change",
            changesSummary: "- `planner.ts`: pure function",
            label: "enhancement",
          },
        ],
      },
      RENDER_CTX,
    );
    expect(body).toContain(DESCRIPTION_REVIEW_MAP_HEADING);
    expect(body).toContain("Intake mapping is the core change");
    expect(body).not.toContain("pure function");
    expect(body).not.toContain("Enhancement (1 file");
  });
});

describe("prBodyHasDescriptionReviewMap", () => {
  it("is true only when both description header and review map heading exist", () => {
    expect(prBodyHasDescriptionReviewMap(null)).toBe(false);
    expect(prBodyHasDescriptionReviewMap(`${DESCRIPTION_AGENT_HEADER}\n\n### PR Type`)).toBe(
      false,
    );
    expect(
      prBodyHasDescriptionReviewMap(
        `${DESCRIPTION_AGENT_HEADER}\n\n${DESCRIPTION_REVIEW_MAP_HEADING}\n\n1. path`,
      ),
    ).toBe(true);
  });
});
