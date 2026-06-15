import path from "node:path";
import { escapeTableHtml, renderInlineCodeLink } from "../../github/markdownFormat.js";
import {
  githubPullRequestFileDiffUrl,
  type GitHubPullRequestFileContext,
} from "../../github/prFileUrls.js";
import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.js";
import { DESCRIPTION_AGENT_HEADER } from "../../settings/index.js";
import type { DescriptionPayload, DescriptionPrFile } from "./descriptionSchema.js";

export { sanitizeMermaidDiagram } from "./mermaidDiagram.js";

export type DescriptionRenderContext = GitHubPullRequestFileContext;

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

function uniqueBasenames(files: readonly DescriptionPrFile[]): Map<string, string> {
  const unique = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const file of files) {
    const base = path.basename(file.filename);
    if (ambiguous.has(base)) continue;
    if (unique.has(base)) {
      unique.delete(base);
      ambiguous.add(base);
    } else {
      unique.set(base, file.filename);
    }
  }
  return unique;
}

function fileUrlByPath(
  files: readonly DescriptionPrFile[],
  ctx: DescriptionRenderContext,
): Map<string, string> {
  const urls = new Map<string, string>();
  for (const file of files) {
    urls.set(file.filename, githubPullRequestFileDiffUrl(ctx, file.filename));
  }
  return urls;
}

function markdownFileLink(display: string, href: string): string {
  return `[${display}](${href})`;
}

function linkifyFileReferences(
  line: string,
  urlByPath: ReadonlyMap<string, string>,
  uniqueBasenameToPath: ReadonlyMap<string, string>,
): string {
  let out = line;
  const paths = [...urlByPath.keys()].toSorted((a, b) => b.length - a.length);
  for (const filePath of paths) {
    const href = urlByPath.get(filePath)!;
    const backtick = `\`${filePath}\``;
    if (out.includes(backtick)) {
      out = out.replaceAll(backtick, markdownFileLink(filePath, href));
    }
  }
  for (const [basename, filePath] of uniqueBasenameToPath) {
    const href = urlByPath.get(filePath)!;
    const backtick = `\`${basename}\``;
    if (out.includes(backtick)) {
      out = out.replaceAll(backtick, markdownFileLink(basename, href));
    }
    const bulletPrefix = `- ${basename}:`;
    if (out.includes(bulletPrefix)) {
      out = out.replaceAll(bulletPrefix, `- ${markdownFileLink(basename, href)}:`);
    }
  }
  return out;
}

function renderFileEntry(
  file: DescriptionPrFile,
  fileHref: string,
  urlByPath: ReadonlyMap<string, string>,
  uniqueBasenameToPath: ReadonlyMap<string, string>,
): string[] {
  const lines: string[] = [
    "<details>",
    `<summary>${escapeTableHtml(file.changesTitle)}</summary>`,
    "",
    renderInlineCodeLink(file.filename, fileHref),
    "",
  ];
  if (file.changesSummary?.trim()) {
    for (const bullet of file.changesSummary.trim().split("\n")) {
      const trimmed = bullet.trim();
      if (!trimmed) continue;
      const normalized = trimmed.startsWith("-") ? trimmed : `- ${trimmed}`;
      lines.push(linkifyFileReferences(normalized, urlByPath, uniqueBasenameToPath));
    }
  }
  lines.push("", "</details>");
  return lines;
}

function renderFileWalkthrough(
  files: readonly DescriptionPrFile[],
  ctx: DescriptionRenderContext,
): string {
  if (files.length === 0) return "";
  const groups = groupFilesByLabel(files);
  const urlByPath = fileUrlByPath(files, ctx);
  const uniqueBasenameToPath = uniqueBasenames(files);
  const lines: string[] = ["### File Walkthrough", ""];
  for (const [label, group] of groups) {
    const labelTitle = `${label.charAt(0).toUpperCase()}${label.slice(1)} (${group.length} file${group.length === 1 ? "" : "s"})`;
    lines.push("<details>", `<summary>${escapeTableHtml(labelTitle)}</summary>`, "");
    for (const file of group) {
      const fileHref = urlByPath.get(file.filename)!;
      lines.push(...renderFileEntry(file, fileHref, urlByPath, uniqueBasenameToPath), "");
    }
    lines.push("</details>", "");
  }
  return lines.join("\n").trimEnd();
}

export function renderDescriptionAgentBlock(
  payload: DescriptionPayload,
  ctx: DescriptionRenderContext,
): string {
  const typeLine = payload.type.join(", ");
  const description = payload.description.trim();
  const diagram = payload.changesDiagram?.trim() ?? "";
  const walkthrough = payload.prFiles?.length ? renderFileWalkthrough(payload.prFiles, ctx) : "";

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
