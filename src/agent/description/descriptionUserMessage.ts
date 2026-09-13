import { wrapUntrustedBlock } from "../prompts/promptBlocks.js";
import { formatDescriptionTitleHardRule } from "./descriptionTitle.js";
import { technicalDepthRule, type DescriptionWritingPolicy } from "./descriptionWritingPolicy.js";

function formatDescriptionBodyHardRule(policy: DescriptionWritingPolicy): string {
  return [
    `Hard rule (body scale: ${policy.bodyScale}):`,
    `Write ${policy.bulletMin}–${policy.bulletMax} markdown bullets.`,
    `Each bullet is one short sentence of at most ${policy.maxWordsPerBullet} words.`,
    technicalDepthRule(policy.technicalDepth),
    "Ground every bullet in the diff. Do not invent behaviour.",
    "Match the bullet count to the real change groups; stay inside the range.",
    visualsHardRule(policy),
  ].join(" ");
}

function visualsHardRule(policy: DescriptionWritingPolicy): string {
  const tierHint =
    policy.bodyScale === "S"
      ? "Add a visual for each theme with a proved shape when a sketch helps reviewers."
      : policy.bodyScale === "M"
        ? "Add visuals for every proved shape; prefer mermaid, diff, and component-tree fences when the diff shows them."
        : "Add every proved visual a stranger needs to read the shape at a glance; use multiple views when one leaves a boundary unclear.";
  return `Visuals: optional visuals[] array after the bullets. ${tierHint} Omit visuals when the diff does not prove a sketch.`;
}

function mapHardRule(policy: DescriptionWritingPolicy): string {
  if (policy.mapMode === "omit") {
    return "Hard rule (map mode: omit): do not emit prFiles. Publish type, description bullets, and optional visuals only. No review map.";
  }
  return [
    "Hard rule (map mode: read_first): emit prFiles with 1–5 entries only.",
    "Order by review risk (auth, data, migrations, core API before tests/docs/chore).",
    "Each entry: filename + changesTitle (one clause why open first).",
    "Do not restate top description bullets, list every file, group by PR-type labels, or emit changesSummary/label.",
  ].join(" ");
}

export function buildDescriptionUserContent(params: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  policy: DescriptionWritingPolicy;
  fileCount: number;
  totalChanges: number;
  truncated: boolean;
  userSupplement?: string;
}): string {
  const {
    owner,
    repo,
    prNumber,
    headSha,
    policy,
    fileCount,
    totalChanges,
    truncated,
    userSupplement,
  } = params;

  return [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\n${wrapUntrustedBlock("user_supplement", userSupplement)}\n` : "",
    "",
    "Trusted context (description writing policy):",
    `- Body scale: ${policy.bodyScale}`,
    `- Map mode: ${policy.mapMode}`,
    `- Technical depth: ${policy.technicalDepth}`,
    `- Bullet range: ${policy.bulletMin}–${policy.bulletMax}`,
    `- Max words per bullet: ${policy.maxWordsPerBullet}`,
    `- Changed files: ${fileCount}`,
    `- Total line changes (additions + deletions): ${totalChanges}`,
    `- Change set truncated: ${truncated ? "yes" : "no"}`,
    formatDescriptionTitleHardRule(),
    formatDescriptionBodyHardRule(policy),
    mapHardRule(policy),
    "",
    "Inspect the changed files and diff, then call submitDescription once with a complete DescriptionPayload.",
  ].join("\n");
}
