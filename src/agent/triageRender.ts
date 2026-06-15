import { escapeTableCellContent, renderTableCode } from "../github/markdownFormat.js";
import type { TriageScope } from "../agentWork/types.js";
import type { BotFindingThread } from "../review/reviewPriorFeedback.js";
import type { TriagePayload, TriageVerdict } from "../review/triageSchema.js";
import { TRIAGE_SUMMARY_SENTINEL } from "../settings.js";

type CommitDetail = {
  readonly sha: string;
  readonly subject: string;
  readonly diff: string;
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function diffStat(diff: string): string {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(" ");
      const path = parts[3]?.replace(/^b\//, "");
      if (path) files.add(path);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }
  return `${files.size} files, +${additions} -${deletions}`;
}

function verdictText(verdict: TriageVerdict): string {
  switch (verdict.verdict) {
    case "fixed":
      return `fixed ${renderTableCode(shortSha(verdict.commitSha))}`;
    case "already-resolved":
      return "already resolved";
    case "skipped":
      return `skipped: ${escapeTableCellContent(verdict.reason)}`;
    case "dismissed":
      return "dismissed";
  }
  const exhaustive: never = verdict;
  return exhaustive;
}

function countVerdicts(payload: TriagePayload, previouslyResolvedCount: number): string {
  const counts = new Map<string, number>([
    ["fixed", 0],
    ["already-resolved", 0],
    ["skipped", 0],
    ["dismissed", 0],
  ]);
  for (const verdict of payload.verdicts) {
    counts.set(verdict.verdict, (counts.get(verdict.verdict) ?? 0) + 1);
  }
  return [
    `${counts.get("fixed")} fixed`,
    `${counts.get("already-resolved")} already resolved`,
    `${counts.get("skipped")} skipped`,
    `${counts.get("dismissed")} dismissed`,
    `${previouslyResolvedCount} previously resolved`,
  ].join(" · ");
}

export function renderTriageReport(params: {
  readonly headSha: string;
  readonly inventory: readonly BotFindingThread[];
  readonly payload: TriagePayload;
  readonly commits: readonly CommitDetail[];
  readonly previouslyResolvedCount: number;
  readonly notice?: string;
  readonly scope?: TriageScope;
  readonly threadRootCommentId?: number;
}): string {
  const verdictById = new Map(
    params.payload.verdicts.map((verdict) => [verdict.threadRootCommentId, verdict]),
  );
  const lines = [
    TRIAGE_SUMMARY_SENTINEL,
    "",
    params.scope === "thread" ? "Scoped to 1 finding." : "Full PR triage.",
  ];
  if (params.threadRootCommentId != null) {
    lines.push(`Thread root: \`${params.threadRootCommentId}\``);
  }
  lines.push(`Evaluated head: ${renderTableCode(params.headSha)}`, "");
  if (params.notice) lines.push(params.notice, "");
  lines.push(countVerdicts(params.payload, params.previouslyResolvedCount), "");
  if (params.commits.length > 0) {
    lines.push("Pushed commits:", "");
    for (const commit of params.commits) {
      lines.push(
        `- ${renderTableCode(shortSha(commit.sha))} ${escapeTableCellContent(commit.subject)} (${diffStat(commit.diff)})`,
      );
    }
    lines.push("");
  }

  lines.push(
    "| Severity | Finding | Location | Verdict | Thread |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const thread of params.inventory) {
    const verdict = verdictById.get(thread.rootCommentId);
    lines.push(
      `| ${[
        thread.severity ?? "unknown",
        escapeTableCellContent(thread.titleSnippet),
        `${renderTableCode(thread.path)} L${thread.line}`,
        verdict ? verdictText(verdict) : "missing",
        `[thread](${thread.threadUrl})`,
      ].join(" | ")} |`,
    );
  }

  return lines.join("\n");
}
