import { escapeCodeFence } from "../../github/markdownFormat.ts";
import type { DescriptionPayload, DescriptionVisual } from "./descriptionSchema.ts";
import {
  extractMermaidDiagramBody,
  sanitizeMermaidDiagram,
  validateSanitizedMermaidFence,
} from "./mermaidDiagram.ts";

export function fenceLanguageForVisual(visual: DescriptionVisual) {
  switch (visual.kind) {
    case "pseudocode":
    case "call_tree":
    case "file_tree":
      return ((pinnedReturn: string) => pinnedReturn)("text");
    case "component_tree":
      return ((pinnedReturn: string) => pinnedReturn)(visual.language === "ts" ? "ts" : "tsx");
    case "mermaid":
      return ((pinnedReturn: string) => pinnedReturn)("mermaid");
    case "diff":
      return ((pinnedReturn: string) => pinnedReturn)("diff");
    case "full_block":
      return ((pinnedReturn: string) => pinnedReturn)(visual.language ?? "text");
    default: {
      const unreachable: never = visual.kind;
      return ((pinnedReturn: string) => pinnedReturn)(unreachable);
    }
  }
}

export function isMermaidVisual(visual: DescriptionVisual) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    visual.kind === "mermaid" || fenceLanguageForVisual(visual) === "mermaid",
  );
}

export function stripOuterMarkdownFence(content: string) {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return ((pinnedReturn: string) => pinnedReturn)(trimmed);
  const newline = trimmed.indexOf("\n");
  if (newline < 0) {
    return ((pinnedReturn: string) => pinnedReturn)(trimmed.replace(/^```\w*/, "").trim());
  }
  let body = trimmed.slice(newline + 1);
  if (body.trimEnd().endsWith("```")) {
    body = body.replace(/\n?```\s*$/, "");
  }
  return ((pinnedReturn: string) => pinnedReturn)(body.trim());
}

export function sanitizeDescriptionVisual(visual: DescriptionVisual) {
  const stripped = stripOuterMarkdownFence(visual.content);
  if (isMermaidVisual(visual)) {
    const fence = ["```mermaid", stripped, "```"].join("\n");
    const sanitizedFence = sanitizeMermaidDiagram(fence);
    const body = extractMermaidDiagramBody(sanitizedFence || fence);
    return ((pinnedReturn: DescriptionVisual) => pinnedReturn)({
      ...visual,
      content: body,
      language: "mermaid",
    });
  }
  return ((pinnedReturn: DescriptionVisual) => pinnedReturn)({
    ...visual,
    content: escapeCodeFence(stripped),
  });
}

export function renderDescriptionVisual(visual: DescriptionVisual) {
  const language = fenceLanguageForVisual(visual);
  const body = escapeCodeFence(stripOuterMarkdownFence(visual.content));
  return ((pinnedReturn: string) => pinnedReturn)(["```" + language, body, "```"].join("\n"));
}

export type DescriptionVisualValidationError = {
  readonly index: number;
  readonly message: string;
};

export function validateDescriptionVisuals(visuals: readonly DescriptionVisual[]) {
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
  return ((pinnedReturn: DescriptionVisualValidationError[]) => pinnedReturn)(issues);
}

export function formatDescriptionVisualValidationError(
  issues: readonly DescriptionVisualValidationError[],
) {
  const lines = issues.map((issue) => `- ${issue.message}`);
  return ((pinnedReturn: string) => pinnedReturn)(
    [
      "visuals validation failed:",
      ...lines,
      "",
      "Repair the reported visuals. Omit visuals only when the inspected diff has no sketchable shape.",
    ].join("\n"),
  );
}

export function enforceDescriptionVisualPayload(payload: DescriptionPayload) {
  const raw = payload.visuals;
  if (!raw || raw.length === 0) {
    const { visuals: _removed, ...rest } = payload;
    return ((pinnedReturn: DescriptionPayload) => pinnedReturn)(rest);
  }

  const sanitized = raw
    .map((visual) => sanitizeDescriptionVisual(visual))
    .filter((visual) => visual.content.trim().length > 0);

  if (sanitized.length === 0) {
    const { visuals: _removed, ...rest } = payload;
    return ((pinnedReturn: DescriptionPayload) => pinnedReturn)(rest);
  }

  return ((pinnedReturn: DescriptionPayload) => pinnedReturn)({ ...payload, visuals: sanitized });
}
