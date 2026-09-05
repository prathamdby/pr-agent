import type { TriageScope } from "../../agentWork/types.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import { formatFindingThreadInventoryLines } from "../prompts/promptBlocks.js";

export function buildTriageUserContent(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly maxFixesPerRun: number;
  readonly threads: readonly BotFindingThread[];
  readonly scope?: TriageScope;
}): string {
  const lines = [
    `Target repository: ${params.owner}/${params.repo}`,
    `Pull request #: ${params.prNumber}`,
    `Head commit SHA: ${params.headSha}`,
    `Fix budget: ${params.maxFixesPerRun}`,
    "",
    params.scope === "thread"
      ? "Triage only the single finding below."
      : "Prior PR Agent findings to triage:",
  ];

  params.threads.forEach((thread, index) => {
    lines.push(...formatFindingThreadInventoryLines(thread, index));
  });

  lines.push("", "Use the writable workspace tools, then call submitTriage once.");
  return lines.join("\n");
}
