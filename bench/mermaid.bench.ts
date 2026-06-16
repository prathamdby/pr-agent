import { bench, describe } from "vitest";
import {
  sanitizeMermaidDiagram,
  validateMermaidDiagram,
} from "../src/agent/description/mermaidDiagram.js";

const messyDiagram = [
  "```mermaid",
  "flowchart LR",
  "  A[/src/index.ts] --> B[load config]",
  "  B --> C[start webhook server (http)]",
  "  C --> D[`enqueue` job]",
  "  D --> E[/handlers/review/]",
  "  E --> F[publish review comments]",
  "  F --> G[update progress]",
  "```",
].join("\n");

const validDiagram = [
  "```mermaid",
  "flowchart LR",
  '  A["webhook"] --> B["parse payload"]',
  '  B --> C["schedule run"]',
  '  C --> D["agent loop"]',
  '  D --> E["publish review"]',
  "```",
].join("\n");

describe("mermaid diagram handling", () => {
  bench("sanitizeMermaidDiagram - messy labels", () => {
    sanitizeMermaidDiagram(messyDiagram);
  });

  bench("validateMermaidDiagram - messy diagram", () => {
    validateMermaidDiagram(messyDiagram);
  });

  bench("validateMermaidDiagram - valid diagram", () => {
    validateMermaidDiagram(validDiagram);
  });
});
