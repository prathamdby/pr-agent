import { redactOutboundSecrets } from "../security/redactOutboundSecrets.js";
import { DESCRIPTION_AGENT_HEADER } from "../settings/index.js";
import type { DescriptionPayload, DescriptionPrFile } from "./descriptionSchema.js";

export function sanitizeMermaidDiagram(diagramRaw: string): string {
  const diagram = diagramRaw.trim();
  if (!diagram.startsWith("```mermaid")) {
    return "";
  }
  let fixed = diagram;
  if (!fixed.endsWith("```")) {
    fixed += "\n```";
  }
  const lines = fixed.split("\n").map((line) =>
    line.replace(/\["([^"]*?)"\]/g, (_match, label: string) => {
      return `["${label.replace(/`/g, "")}"]`;
    }),
  );
  return lines.join("\n");
}

function groupFilesByLabel(files: readonly DescriptionPrFile[]): Map<string, DescriptionPrFile[]> {
  const groups = new Map<string, DescriptionPrFile[]>();
  for (const file of files) {
    const key = file.label.trim().toLowerCase();
    const bucket = groups.get(key) ?? [];
    bucket.push(file);
    groups.set(key, bucket);
  }
  return groups;
}

function renderFileWalkthrough(files: readonly DescriptionPrFile[]): string {
  if (files.length === 0) return "";
  const groups = groupFilesByLabel(files);
  const lines: string[] = ["### File Walkthrough", ""];
  for (const [label, group] of groups) {
    lines.push(`**${label.charAt(0).toUpperCase()}${label.slice(1)}**`, "");
    for (const file of group) {
      lines.push(`- \`${file.filename}\`: ${file.changesTitle}`);
      if (file.changesSummary?.trim()) {
        for (const bullet of file.changesSummary.trim().split("\n")) {
          const trimmed = bullet.trim();
          if (trimmed) lines.push(`  ${trimmed.startsWith("-") ? trimmed : `- ${trimmed}`}`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

export function renderDescriptionAgentBlock(payload: DescriptionPayload): string {
  const typeLine = payload.type.join(", ");
  const description = payload.description.trim();
  const diagram = payload.changesDiagram ? sanitizeMermaidDiagram(payload.changesDiagram) : "";
  const walkthrough = payload.prFiles?.length ? renderFileWalkthrough(payload.prFiles) : "";

  const sections = [
    DESCRIPTION_AGENT_HEADER,
    "",
    "### PR Type",
    "",
    typeLine,
    "",
    "### Description",
    "",
    description,
  ];

  if (diagram) {
    sections.push("", "### Changes Diagram", "", diagram);
  }
  if (walkthrough) {
    sections.push("", walkthrough);
  }

  return redactOutboundSecrets(sections.join("\n").trimEnd());
}
