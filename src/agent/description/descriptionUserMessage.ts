import { wrapUntrustedBlock } from "../prompts/promptBlocks.js";
import { formatDescriptionTitleHardRule } from "./descriptionTitle.js";
import { technicalDepthRule, type DescriptionWritingPolicy } from "./descriptionWritingPolicy.js";

function formatDescriptionBodyHardRule(policy: DescriptionWritingPolicy): string {
  return [
    `Hard rule (body scale: ${policy.bodyScale}):`,
    `Write ${policy.bulletMin}–${policy.bulletMax} short markdown bullets as theme summaries.`,
    `Each bullet is one short sentence of at most ${policy.maxWordsPerBullet} words.`,
    technicalDepthRule(policy.technicalDepth),
    "Ground every bullet in the diff. Do not invent behaviour.",
    "Prefer the low end of the bullet range. Put structural shape in visuals[], not long prose.",
    "Do not narrate a flow, tree, contract, or module interaction in bullets when a visual already shows it.",
    visualsHardRule(policy),
  ].join(" ");
}

function visualsHardRule(policy: DescriptionWritingPolicy): string {
  const tierHint =
    policy.bodyScale === "S"
      ? "Emit the smallest useful set; stop at one or two views once the proved shape is clear."
      : policy.bodyScale === "M"
        ? "Emit one view per distinct helpful proved category; add a second view only when the first leaves a boundary unclear."
        : "Follow the M rule, then add views when one fence leaves a contract, data path, or module boundary unclear.";
  return `Hard rule (visuals): lean on visuals[]. ${tierHint} Omit visuals only when the inspected diff has no sketchable shape.`;
}

function mapHardRule(policy: DescriptionWritingPolicy): string {
  if (policy.mapMode === "omit") {
    return "Hard rule (map mode: omit): do not emit prFiles. Publish type, short description bullets, and visuals. No review map.";
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
