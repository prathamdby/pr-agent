import { escapeTableHtml, renderInlineCodeLink } from "../../github/markdownFormat.js";
import { createHash } from "node:crypto";
import type { PrResource } from "../../agentWork/types.js";
import { redactOutboundSecrets } from "../../security/redactOutboundSecrets.js";
import { DESCRIPTION_AGENT_HEADER, DESCRIPTION_REVIEW_MAP_HEADING } from "../../settings/index.js";
import { extractAgentDescriptionBlock } from "./descriptionBodyMerge.js";
import type { DescriptionPayload, DescriptionPrFile } from "./descriptionSchema.js";
import { renderDescriptionVisual } from "./descriptionVisualSanitize.js";

function renderReviewMap(files: readonly DescriptionPrFile[], ctx: PrResource): string {
  if (files.length === 0) return "";
  const lines: string[] = [DESCRIPTION_REVIEW_MAP_HEADING, ""];
  files.forEach((file, index) => {
    const href = githubPullRequestFileDiffUrl(ctx, file.filename);
    const reason = escapeTableHtml(file.changesTitle.trim());
    lines.push(`${index + 1}. ${renderInlineCodeLink(file.filename, href)}: ${reason}`);
  });
  return lines.join("\n").trimEnd();
}

function renderVisuals(payload: DescriptionPayload): string {
  const visuals = payload.visuals;
  if (!visuals || visuals.length === 0) return "";
  return visuals.map((visual) => renderDescriptionVisual(visual)).join("\n\n");
}

export function renderDescriptionAgentBlock(payload: DescriptionPayload, ctx: PrResource): string {
  const typeLine = payload.type.join(", ");
  const description = payload.description.trim();
  const visualBlock = renderVisuals(payload);
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

  if (visualBlock) {
    sections.push("", visualBlock);
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

/** Anchor id for a file row on the PR "Files changed" tab (SHA-256 of the repo path). */
function githubPullRequestFileDiffAnchor(filePath: string): string {
  const digest = createHash("sha256").update(filePath).digest("hex");
  return `diff-${digest}`;
}

/** Link to a file's diff hunk on the pull request Files changed tab. */
function githubPullRequestFileDiffUrl(ctx: PrResource, filePath: string): string {
  const anchor = githubPullRequestFileDiffAnchor(filePath);
  return `https://github.com/${ctx.owner}/${ctx.repo}/pull/${ctx.prNumber}/files#${anchor}`;
}
