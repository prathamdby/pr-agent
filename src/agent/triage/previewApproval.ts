import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.js";
import type { TriagePayload, TriageVerdict } from "../../review/triageSchema.js";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.js";
import type { TriagePreviewHunk } from "./triageRender.js";

const exec = promisify(execFile);

export function previewHunkHasDiff(hunk: TriagePreviewHunk): boolean {
  return hunk.diff.trim().length > 0;
}

export function approvedPreviewThreads(params: {
  readonly inventory: readonly BotFindingThread[];
  readonly previewIds: ReadonlySet<number>;
  readonly excludeIds: ReadonlySet<number>;
}): readonly BotFindingThread[] {
  return params.inventory.filter(
    (thread) =>
      params.previewIds.has(thread.rootCommentId) && !params.excludeIds.has(thread.rootCommentId),
  );
}

export function approvedPreviewHunks(params: {
  readonly hunks: readonly TriagePreviewHunk[];
  readonly approvedIds: ReadonlySet<number>;
}): readonly TriagePreviewHunk[] {
  return params.hunks.filter(
    (hunk) => params.approvedIds.has(hunk.threadRootCommentId) && previewHunkHasDiff(hunk),
  );
}

export function pathsFromUnifiedDiff(diff: string): readonly string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    const path = match?.[2];
    if (path != null && path.length > 0) paths.push(path);
  }
  return [...new Set(paths)];
}

export function remapBulkPayload(params: {
  readonly payload: TriagePayload;
  readonly approvedIds: ReadonlySet<number>;
  readonly appliedCommits: ReadonlyMap<number, string>;
}): TriagePayload {
  const verdicts: TriageVerdict[] = [];
  for (const verdict of params.payload.verdicts) {
    if (!params.approvedIds.has(verdict.threadRootCommentId)) continue;
    switch (verdict.verdict) {
      case "fixed": {
        const sha = params.appliedCommits.get(verdict.threadRootCommentId);
        if (sha == null) break;
        verdicts.push({ ...verdict, commitSha: sha });
        break;
      }
      case "already-resolved":
      case "skipped":
      case "dismissed":
        verdicts.push(verdict);
        break;
      default: {
        const exhaustive: never = verdict;
        return exhaustive;
      }
    }
  }
  return { verdicts };
}

export async function applyGitDiff(dir: string, diff: string): Promise<void> {
  const input = diff.endsWith("\n") ? diff : `${diff}\n`;
  const scratch = await mkdtemp(join(tmpdir(), "triage-preview-hunk-"));
  const patchPath = join(scratch, "hunk.diff");
  try {
    await writeFile(patchPath, input, "utf8");
    await exec("git", ["apply", "--whitespace=nowarn", patchPath], {
      cwd: dir,
      timeout: 30_000,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function resetUncommittedCheckout(dir: string): Promise<void> {
  await exec("git", ["reset", "--hard", "HEAD"], { cwd: dir, timeout: 30_000 });
}

export async function replayPreviewHunks(params: {
  readonly checkout: WritablePrCheckout;
  readonly hunks: readonly TriagePreviewHunk[];
  readonly applyDiff?: (dir: string, diff: string) => Promise<void>;
  readonly resetUncommitted?: (dir: string) => Promise<void>;
}): Promise<{
  readonly commitByThreadRootCommentId: Map<number, string>;
  readonly commitErrors: { readonly threadRootCommentId: number; readonly error: string }[];
}> {
  const applyDiff = params.applyDiff ?? applyGitDiff;
  const resetUncommitted = params.resetUncommitted ?? resetUncommittedCheckout;
  const commitByThreadRootCommentId = new Map<number, string>();
  const commitErrors: { readonly threadRootCommentId: number; readonly error: string }[] = [];
  for (const hunk of params.hunks) {
    const files = pathsFromUnifiedDiff(hunk.diff);
    if (files.length === 0) {
      commitErrors.push({
        threadRootCommentId: hunk.threadRootCommentId,
        error: "preview hunk has no applyable paths",
      });
      continue;
    }
    try {
      await applyDiff(params.checkout.dir, hunk.diff);
      const committed = await params.checkout.commit({ files, subject: hunk.subject });
      commitByThreadRootCommentId.set(hunk.threadRootCommentId, committed.sha);
    } catch (error) {
      try {
        await resetUncommitted(params.checkout.dir);
      } catch {
        // Keep the first apply/commit error. Reset is best-effort so later hunks can proceed.
      }
      commitErrors.push({
        threadRootCommentId: hunk.threadRootCommentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { commitByThreadRootCommentId, commitErrors };
}

export function previewApprovalSets(params: {
  readonly inventory: readonly BotFindingThread[];
  readonly preview: {
    readonly threadRootCommentIds: readonly number[];
    readonly hunks: readonly TriagePreviewHunk[];
  };
  readonly excludeIds: ReadonlySet<number>;
}): {
  readonly approvedInventory: readonly BotFindingThread[];
  readonly approvedIds: ReadonlySet<number>;
  readonly approvedHunks: readonly TriagePreviewHunk[];
  readonly excludedIds: ReadonlySet<number>;
  readonly notInPreviewIds: ReadonlySet<number>;
} {
  const previewIds = new Set(params.preview.threadRootCommentIds);
  const excludedIds = new Set(
    params.inventory
      .filter((thread) => params.excludeIds.has(thread.rootCommentId))
      .map((thread) => thread.rootCommentId),
  );
  const notInPreviewIds = new Set(
    params.inventory
      .filter((thread) => !previewIds.has(thread.rootCommentId))
      .map((thread) => thread.rootCommentId),
  );
  const approvedInventory = approvedPreviewThreads({
    inventory: params.inventory,
    previewIds,
    excludeIds: params.excludeIds,
  });
  const approvedIds = new Set(approvedInventory.map((thread) => thread.rootCommentId));
  return {
    approvedInventory,
    approvedIds,
    approvedHunks: approvedPreviewHunks({ hunks: params.preview.hunks, approvedIds }),
    excludedIds,
    notInPreviewIds,
  };
}
