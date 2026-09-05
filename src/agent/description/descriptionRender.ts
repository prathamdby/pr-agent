import { escapeTableHtml, renderInlineCodeLink } from "../../github/markdownFormat.js";
import {
  githubPullRequestFileDiffUrl,
  type GitHubPullRequestFileContext,
} from "../../github/prFileUrls.js";
import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.js";
import { DESCRIPTION_AGENT_HEADER, DESCRIPTION_REVIEW_MAP_HEADING } from "../../settings/index.js";
import { extractAgentDescriptionBlock } from "./descriptionBodyMerge.js";
import type { DescriptionPayload, DescriptionPrFile } from "./descriptionSchema.js";

export type DescriptionRenderContext = GitHubPullRequestFileContext;

function renderReviewMap(
  files: readonly DescriptionPrFile[],
  ctx: DescriptionRenderContext,
): string {
  if (files.length === 0) return "";
  const lines: string[] = [DESCRIPTION_REVIEW_MAP_HEADING, ""];
  files.forEach((file, index) => {
    const href = githubPullRequestFileDiffUrl(ctx, file.filename);
    const reason = escapeTableHtml(file.changesTitle.trim());
    lines.push(`${index + 1}. ${renderInlineCodeLink(file.filename, href)}: ${reason}`);
  });
  return lines.join("\n").trimEnd();
}

export function renderDescriptionAgentBlock(
  payload: DescriptionPayload,
  ctx: DescriptionRenderContext,
): string {
  const typeLine = payload.type.join(", ");
  const description = payload.description.trim();
  const diagram = payload.changesDiagram?.trim() ?? "";
  const reviewMap = payload.prFiles?.length ? renderReviewMap(payload.prFiles, ctx) : "";

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
  if (reviewMap) {
    sections.push("", reviewMap);
  }

  return redactOutboundSecrets(sections.join("\n").trimEnd());
}

export function prBodyHasDescriptionReviewMap(body: string | null | undefined): boolean {
  const agentBlock = extractAgentDescriptionBlock(body);
  if (!agentBlock) return false;
  return agentBlock.includes(DESCRIPTION_REVIEW_MAP_HEADING);
}
