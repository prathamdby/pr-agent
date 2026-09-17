import type { DescriptionPayload, DescriptionVisual } from "./descriptionSchema.js";
import {
  extractMermaidDiagramBody,
  sanitizeMermaidDiagram,
  validateSanitizedMermaidFence,
} from "./mermaidDiagram.js";

const FENCE_BREAKER_RE = /```/g;

export function fenceLanguageForVisual(visual: DescriptionVisual): string {
  switch (visual.kind) {
    case "pseudocode":
    case "call_tree":
    case "file_tree":
      return "text";
    case "component_tree":
      return visual.language === "ts" ? "ts" : "tsx";
    case "mermaid":
      return "mermaid";
    case "diff":
      return "diff";
    case "full_block":
      return visual.language ?? "text";
    default: {
      const unreachable: never = visual.kind;
      return unreachable;
    }
  }
}

export function isMermaidVisual(visual: DescriptionVisual): boolean {
  return visual.kind === "mermaid" || fenceLanguageForVisual(visual) === "mermaid";
}

/** Remove one outer markdown fence so the server always owns the wrapper. */
export function stripOuterMarkdownFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const newline = trimmed.indexOf("\n");
  if (newline < 0) {
    return trimmed.replace(/^```\w*/, "").trim();
  }
  let body = trimmed.slice(newline + 1);
  if (body.trimEnd().endsWith("```")) {
    body = body.replace(/\n?```\s*$/, "");
  }
  return body.trim();
}

function escapeFenceBreakers(text: string): string {
  return text.replace(FENCE_BREAKER_RE, "\\`\\`\\`");
}

export function sanitizeDescriptionVisual(visual: DescriptionVisual): DescriptionVisual {
  const stripped = stripOuterMarkdownFence(visual.content);
  if (isMermaidVisual(visual)) {
    const fence = ["```mermaid", stripped, "```"].join("\n");
    const sanitizedFence = sanitizeMermaidDiagram(fence);
    const body = extractMermaidDiagramBody(sanitizedFence || fence);
    return { ...visual, content: body, language: "mermaid" };
  }
  return { ...visual, content: escapeFenceBreakers(stripped) };
}

export function renderDescriptionVisual(visual: DescriptionVisual): string {
  const language = fenceLanguageForVisual(visual);
  const body = escapeFenceBreakers(stripOuterMarkdownFence(visual.content));
  return ["```" + language, body, "```"].join("\n");
}

export type DescriptionVisualValidationError = {
  readonly index: number;
  readonly message: string;
};

export function validateDescriptionVisuals(
  visuals: readonly DescriptionVisual[],
): DescriptionVisualValidationError[] {
  const issues: DescriptionVisualValidationError[] = [];
  visuals.forEach((visual, index) => {
    if (!visual.content.trim()) {
      issues.push({ index, message: `visuals[${index}] content is empty.` });
    }
    if (isMermaidVisual(visual)) {
      const fence = visual.content.trim().startsWith("```mermaid")
        ? visual.content.trim()
        : ["```mermaid", stripOuterMarkdownFence(visual.content), "```"].join("\n");
      const mermaidIssues = validateSanitizedMermaidFence(fence);
      for (const issue of mermaidIssues) {
        issues.push({
          index,
          message: `visuals[${index}] mermaid line ${issue.line}: ${issue.message}`,
        });
      }
    }
  });
  return issues;
}

export function formatDescriptionVisualValidationError(
  issues: readonly DescriptionVisualValidationError[],
): string {
  const lines = issues.map((issue) => `- ${issue.message}`);
  return [
    "visuals validation failed:",
    ...lines,
    "",
    "Repair the reported visuals. Omit visuals only when the inspected diff has no sketchable shape.",
  ].join("\n");
}

export function enforceDescriptionVisualPayload(payload: DescriptionPayload): DescriptionPayload {
  const raw = payload.visuals;
  if (!raw || raw.length === 0) {
    const { visuals: _removed, ...rest } = payload;
    return rest;
  }

  const sanitized = raw
    .map((visual) => sanitizeDescriptionVisual(visual))
    .filter((visual) => visual.content.trim().length > 0);

  if (sanitized.length === 0) {
    const { visuals: _removed, ...rest } = payload;
    return rest;
  }

  return { ...payload, visuals: sanitized };
}
