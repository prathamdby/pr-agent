import { escapeTableCellContent, renderTableCode } from "../../github/markdownFormat.js";
import type { TriageScope } from "../../agentWork/types.js";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { TriagePayload, TriageVerdict } from "../../review/triageSchema.js";
import { renderPolicySuggestionForDismissed } from "../../review/repoPolicy.js";
import { TRIAGE_PREVIEW_SENTINEL, TRIAGE_SUMMARY_SENTINEL } from "../../settings/index.js";

export type TriagePreviewHunk = {
  readonly threadRootCommentId: number;
  readonly subject: string;
  readonly diff: string;
};

export type TriageBulkOutcome = "applied" | "skipped" | "failed";

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
      return `Fixed ${renderTableCode(shortSha(verdict.commitSha))}`;
    case "already-resolved":
      return "Already resolved";
    case "skipped":
      return `Skipped: ${escapeTableCellContent(verdict.reason)}`;
    case "dismissed":
      return "Dismissed";
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
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
    `${counts.get("fixed")} Fixed`,
    `${counts.get("already-resolved")} Already resolved`,
    `${counts.get("skipped")} Skipped`,
    `${counts.get("dismissed")} Dismissed`,
    `${previouslyResolvedCount} Previously resolved`,
  ].join(" · ");
}

export function classifyTriageBulkOutcome(params: {
  readonly verdict?: TriageVerdict;
  readonly hasCommit: boolean;
  readonly commitError: boolean;
  readonly excluded: boolean;
  readonly notInPreview: boolean;
  readonly pushed: boolean;
}): TriageBulkOutcome {
  if (params.excluded || params.notInPreview) return "skipped";
  if (params.commitError) return "failed";
  if (params.verdict == null) return "failed";
  switch (params.verdict.verdict) {
    case "fixed":
      if (!params.hasCommit) return "failed";
      return params.pushed ? "applied" : "failed";
    case "already-resolved":
    case "skipped":
    case "dismissed":
      return "skipped";
    default: {
      const exhaustive: never = params.verdict;
      return exhaustive;
    }
  }
}

export function classifyTriageBulkOutcomes(params: {
  readonly inventory: readonly BotFindingThread[];
  readonly payload: TriagePayload;
  readonly commitByThreadRootCommentId: ReadonlyMap<number, string>;
  readonly commitErrors: readonly { readonly threadRootCommentId: number }[];
  readonly excludedIds: ReadonlySet<number>;
  readonly notInPreviewIds: ReadonlySet<number>;
  readonly pushed: boolean;
}): Map<number, TriageBulkOutcome> {
  const verdictById = new Map(
    params.payload.verdicts.map((verdict) => [verdict.threadRootCommentId, verdict]),
  );
  const errorIds = new Set(params.commitErrors.map((entry) => entry.threadRootCommentId));
  const outcomes = new Map<number, TriageBulkOutcome>();
  for (const thread of params.inventory) {
    outcomes.set(
      thread.rootCommentId,
      classifyTriageBulkOutcome({
        verdict: verdictById.get(thread.rootCommentId),
        hasCommit: params.commitByThreadRootCommentId.has(thread.rootCommentId),
        commitError: errorIds.has(thread.rootCommentId),
        excluded: params.excludedIds.has(thread.rootCommentId),
        notInPreview: params.notInPreviewIds.has(thread.rootCommentId),
        pushed: params.pushed,
      }),
    );
  }
  return outcomes;
}

export function renderTriagePreview(params: {
  readonly headSha: string;
  readonly inventory: readonly BotFindingThread[];
  readonly hunks: readonly TriagePreviewHunk[];
  readonly scope?: TriageScope;
  readonly threadRootCommentId?: number;
}): string {
  const hunkById = new Map(params.hunks.map((hunk) => [hunk.threadRootCommentId, hunk]));
  const lines = [
    TRIAGE_PREVIEW_SENTINEL,
    "",
    params.scope === "thread" ? "Preview scoped to 1 finding." : "Preview of eligible findings.",
  ];
  if (params.threadRootCommentId != null) {
    lines.push(`Thread root: \`${params.threadRootCommentId}\``);
  }
  lines.push(
    `Evaluated head: ${renderTableCode(params.headSha)}`,
    "",
    "Nothing was committed or pushed. Thread state is unchanged.",
    "Next: `/triage all` applies this set. Opt out with `/triage all exclude <thread ids>`.",
    "",
  );
  for (const thread of params.inventory) {
    const hunk = hunkById.get(thread.rootCommentId);
    lines.push(
      `### ${escapeTableCellContent(thread.titleSnippet)}`,
      "",
      `Thread root: \`${thread.rootCommentId}\` · ${renderTableCode(thread.path)} L${thread.line} · [thread](${thread.threadUrl})`,
      "",
    );
    if (hunk == null || hunk.diff.trim() === "") {
      lines.push("No would-be diff for this finding.", "");
      continue;
    }
    lines.push(hunk.subject, "", "```diff", hunk.diff.replace(/```/g, ""), "```", "");
  }
  return lines.join("\n");
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
  readonly bulkOutcomes?: ReadonlyMap<number, TriageBulkOutcome>;
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

  const showOutcomes = params.bulkOutcomes != null;
  lines.push(
    showOutcomes
      ? "| Severity | Finding | Location | Verdict | Outcome | Thread |"
      : "| Severity | Finding | Location | Verdict | Thread |",
    showOutcomes ? "| --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- |",
  );
  for (const thread of params.inventory) {
    const verdict = verdictById.get(thread.rootCommentId);
    const outcome = params.bulkOutcomes?.get(thread.rootCommentId);
    lines.push(
      `| ${[
        thread.severity ?? "unknown",
        escapeTableCellContent(thread.titleSnippet),
        `${renderTableCode(thread.path)} L${thread.line}`,
        verdict ? verdictText(verdict) : "missing",
        ...(showOutcomes ? [outcome ?? "skipped"] : []),
        `[thread](${thread.threadUrl})`,
      ].join(" | ")} |`,
    );
  }

  const dismissedSuggestions = params.payload.verdicts.filter(
    (verdict): verdict is Extract<TriageVerdict, { verdict: "dismissed" }> =>
      verdict.verdict === "dismissed",
  );
  if (dismissedSuggestions.length > 0) {
    const threadById = new Map(params.inventory.map((thread) => [thread.rootCommentId, thread]));
    lines.push("", "### Policy suggestions for dismissed findings", "");
    lines.push("Commit these to `.pr-agent/*.mdc` to steer future reviews:", "");
    for (const verdict of dismissedSuggestions) {
      const thread = threadById.get(verdict.threadRootCommentId);
      if (!thread) continue;
      lines.push(
        renderPolicySuggestionForDismissed({
          filePath: thread.path,
          dismissalEvidence: verdict.evidence,
        }),
      );
    }
  }

  return lines.join("\n");
}
