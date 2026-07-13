import { createHash } from "node:crypto";
import { wrapUntrustedBlock } from "../../agent/prompts/promptBlocks.js";
import type { ListPullRequestFilesResult } from "../../github/listPullRequestFiles.js";
import type { LocalPrWorkspace } from "../../prWorkspace/localPrWorkspace.js";
import { REVIEW_EVIDENCE_CONTRACT_VERSION } from "../../settings/index.js";
import { classifyReviewBudgetTier, type ReviewBudgetTier } from "./reviewSizeBudget.js";

export type ReviewEvidenceDiffOmissionReason =
  | "patch-byte-cap"
  | "evidence-byte-cap"
  | "diff-unavailable";

export type ReviewEvidenceFile = {
  readonly path: string;
  readonly status: string;
  readonly oldPath?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly diff?: string;
  readonly diffOmitted?: ReviewEvidenceDiffOmissionReason;
};

export type ReviewEvidenceSource = "github-listing" | "git-derived";

export type ReviewEvidenceSnapshot = {
  readonly contractVersion: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly baseSha: string | null;
  readonly headSha: string;
  readonly source: ReviewEvidenceSource;
  readonly truncatedListing: boolean;
  readonly budgetTier: ReviewBudgetTier;
  readonly files: readonly ReviewEvidenceFile[];
  readonly coverageGaps: readonly string[];
  readonly sloExempt: boolean;
  readonly sloExemptReasons: readonly string[];
  readonly policyContext: string;
  readonly priorInlineFeedback: string | null;
  readonly evidenceHash: string;
};

/** Comprehensive coverage could not be established; the Review must fail instead of publishing partial coverage. */
export class ReviewEvidenceCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewEvidenceCoverageError";
  }
}

const PATCH_CAP_MARKER = "[patch omitted: exceeds configured PR patch byte cap]";
const EVIDENCE_BUDGET_MARKER = "[diff omitted: evidence diff byte ceiling exceeded]";

function classifyDiff(diff: string): {
  diff?: string;
  diffOmitted?: ReviewEvidenceDiffOmissionReason;
} {
  if (diff === PATCH_CAP_MARKER) return { diffOmitted: "patch-byte-cap" };
  if (diff === EVIDENCE_BUDGET_MARKER) return { diffOmitted: "evidence-byte-cap" };
  if (diff.length === 0) return { diffOmitted: "diff-unavailable" };
  return { diff };
}

/** SLO exemption reasons for large or truncated change sets (R22). */
export function classifyReviewSloExemption(params: {
  readonly truncated: boolean;
  readonly budgetTier: ReviewBudgetTier;
}): readonly string[] {
  const reasons: string[] = [];
  if (params.truncated) reasons.push("truncated-listing");
  if (params.budgetTier === "large") reasons.push("large-change-set");
  return reasons;
}

function canonicalEvidenceJson(snapshot: Omit<ReviewEvidenceSnapshot, "evidenceHash">): string {
  return JSON.stringify({
    contractVersion: snapshot.contractVersion,
    owner: snapshot.owner,
    repo: snapshot.repo,
    prNumber: snapshot.prNumber,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    source: snapshot.source,
    truncatedListing: snapshot.truncatedListing,
    budgetTier: snapshot.budgetTier,
    files: snapshot.files.map((file) => ({
      path: file.path,
      status: file.status,
      oldPath: file.oldPath ?? null,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
      diff: file.diff ?? null,
      diffOmitted: file.diffOmitted ?? null,
    })),
    coverageGaps: snapshot.coverageGaps,
    sloExempt: snapshot.sloExempt,
    sloExemptReasons: snapshot.sloExemptReasons,
    policyContext: snapshot.policyContext,
    priorInlineFeedback: snapshot.priorInlineFeedback,
  });
}

export async function buildReviewEvidenceSnapshot(params: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly prFiles: ListPullRequestFilesResult;
  readonly workspace: LocalPrWorkspace;
  readonly policyContext: string;
  readonly priorInlineFeedback?: string;
}): Promise<ReviewEvidenceSnapshot> {
  const { prFiles, workspace } = params;
  if (prFiles.truncated && !workspace.baseDerivation) {
    throw new ReviewEvidenceCoverageError(
      "Changed-file listing is truncated and no authoritative git derivation is available",
    );
  }

  const statsByPath = new Map(
    prFiles.files.map((file) => [
      file.filename,
      { additions: file.additions, deletions: file.deletions },
    ]),
  );
  const sortedChanged = [...workspace.changedFiles].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const files: ReviewEvidenceFile[] = [];
  const omissionCounts = new Map<ReviewEvidenceDiffOmissionReason, number>();
  for (const changed of sortedChanged) {
    const diffResult = classifyDiff(await workspace.getDiffForPath(changed.path));
    if (diffResult.diffOmitted) {
      omissionCounts.set(
        diffResult.diffOmitted,
        (omissionCounts.get(diffResult.diffOmitted) ?? 0) + 1,
      );
    }
    const stats = statsByPath.get(changed.path);
    files.push({
      path: changed.path,
      status: changed.status,
      ...(changed.oldPath ? { oldPath: changed.oldPath } : {}),
      ...(stats ? { additions: stats.additions, deletions: stats.deletions } : {}),
      ...diffResult,
    });
  }

  const coverageGaps: string[] = [];
  const patchCapCount = omissionCounts.get("patch-byte-cap") ?? 0;
  if (patchCapCount > 0) {
    coverageGaps.push(`${patchCapCount} file diff(s) omitted by the PR patch byte cap`);
  }
  const evidenceCapCount = omissionCounts.get("evidence-byte-cap") ?? 0;
  if (evidenceCapCount > 0) {
    coverageGaps.push(`${evidenceCapCount} file diff(s) omitted by the evidence diff byte ceiling`);
  }
  if (prFiles.warning) coverageGaps.push(prFiles.warning);

  const budgetTier = classifyReviewBudgetTier({
    fileCount: files.length,
    totalChanges: prFiles.totalChanges,
    truncated: prFiles.truncated,
  });
  const sloExemptReasons = classifyReviewSloExemption({
    truncated: prFiles.truncated,
    budgetTier,
  });
  const withoutHash: Omit<ReviewEvidenceSnapshot, "evidenceHash"> = {
    contractVersion: REVIEW_EVIDENCE_CONTRACT_VERSION,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    baseSha: workspace.baseDerivation?.baseSha ?? prFiles.baseSha ?? null,
    headSha: params.headSha,
    source: workspace.baseDerivation ? "git-derived" : "github-listing",
    truncatedListing: prFiles.truncated,
    budgetTier,
    files,
    coverageGaps,
    sloExempt: sloExemptReasons.length > 0,
    sloExemptReasons,
    policyContext: params.policyContext,
    priorInlineFeedback: params.priorInlineFeedback ?? null,
  };
  const evidenceHash = createHash("sha256")
    .update(canonicalEvidenceJson(withoutHash))
    .digest("hex");
  return { ...withoutHash, evidenceHash };
}

/** Render the shared evidence snapshot for critic prompts. Diff content stays untrusted. */
export function formatReviewEvidenceBlock(snapshot: ReviewEvidenceSnapshot): string {
  const header = [
    "Trusted context (shared Review evidence):",
    `- Evidence hash: ${snapshot.evidenceHash}`,
    `- Contract version: ${snapshot.contractVersion}`,
    `- Source: ${snapshot.source}`,
    `- Base SHA: ${snapshot.baseSha ?? "unknown"}`,
    `- Head SHA: ${snapshot.headSha}`,
    `- Changed files: ${snapshot.files.length}`,
    `- Truncated listing: ${snapshot.truncatedListing ? "yes (authoritative set derived from git)" : "no"}`,
    `- Coverage gaps: ${snapshot.coverageGaps.length > 0 ? snapshot.coverageGaps.join("; ") : "none"}`,
    ...(snapshot.sloExempt ? [`- SLO exempt: ${snapshot.sloExemptReasons.join(", ")}`] : []),
  ].join("\n");
  const fileEntries = snapshot.files
    .map((file) => {
      const stats =
        file.additions != null && file.deletions != null
          ? ` (+${file.additions} -${file.deletions})`
          : "";
      const rename = file.oldPath ? ` (from ${file.oldPath})` : "";
      const head = `### ${file.path} [${file.status}]${rename}${stats}`;
      if (file.diff) return `${head}\n${file.diff}`;
      return `${head}\n[diff omitted: ${file.diffOmitted ?? "diff-unavailable"}]`;
    })
    .join("\n\n");
  return [
    header,
    snapshot.policyContext.trim()
      ? `## Repository policy and trusted context\n${snapshot.policyContext.trim()}`
      : "",
    snapshot.priorInlineFeedback?.trim()
      ? `## Prior inline feedback\n${snapshot.priorInlineFeedback.trim()}`
      : "",
    wrapUntrustedBlock("shared_evidence_diffs", fileEntries),
  ]
    .filter(Boolean)
    .join("\n\n");
}
