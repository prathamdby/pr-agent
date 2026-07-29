import { wrapUntrustedBlock } from "../prompts/promptBlocks.js";
import type { DescriptionMapMode } from "./descriptionMapMode.js";

export function buildDescriptionUserContent(params: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  mapMode: DescriptionMapMode;
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
    mapMode,
    fileCount,
    totalChanges,
    truncated,
    userSupplement,
  } = params;

  const mapHardRule =
    mapMode === "omit"
      ? "Hard rule: do not emit prFiles. Publish type, description bullets, and optional Mermaid only. No review map."
      : [
          "Hard rule: emit prFiles with 1–5 entries only.",
          "Order by review risk (auth, data, migrations, core API before tests/docs/chore).",
          "Each entry: filename + changesTitle (one clause why open first).",
          "Do not restate top description bullets, list every file, group by PR-type labels, or emit changesSummary/label.",
        ].join(" ");

  return [
    `Target repository: ${owner}/${repo}`,
    `Pull request #: ${prNumber}`,
    `Head commit SHA: ${headSha}`,
    userSupplement ? `\n${wrapUntrustedBlock("user_supplement", userSupplement)}\n` : "",
    "",
    "Trusted context (description map mode):",
    `- Map mode: ${mapMode}`,
    `- Changed files: ${fileCount}`,
    `- Total line changes (additions + deletions): ${totalChanges}`,
    `- Change set truncated: ${truncated ? "yes" : "no"}`,
    mapHardRule,
    "",
    "Inspect the changed files and diff, then call submitDescription once with a complete DescriptionPayload.",
  ].join("\n");
}
