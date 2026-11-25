import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BotFindingThread } from "../../review/run/reviewPriorFeedback.ts";
import type { TriagePayload, TriageVerdict } from "../../review/triageSchema.ts";
import type { WritablePrCheckout } from "../../prWorkspace/writablePrCheckout.ts";
import type { TriagePreviewHunk } from "./triageRender.ts";
import { errorMessage } from "../../errors/errorMessage.ts";

const exec = promisify(execFile);

export function previewHunkHasDiff(hunk: TriagePreviewHunk) {
  return ((pinnedReturn: boolean) => pinnedReturn)(hunk.diff.trim().length > 0);
}

export function approvedPreviewThreads(params: {
  readonly inventory: readonly BotFindingThread[];
  readonly previewIds: ReadonlySet<number>;
  readonly excludeIds: ReadonlySet<number>;
}) {
  return ((pinnedReturn: readonly BotFindingThread[]) => pinnedReturn)(
    params.inventory.filter(
      (thread) =>
        params.previewIds.has(thread.rootCommentId) && !params.excludeIds.has(thread.rootCommentId),
    ),
  );
}

export function approvedPreviewHunks(params: {
  readonly hunks: readonly TriagePreviewHunk[];
  readonly approvedIds: ReadonlySet<number>;
}) {
  return ((pinnedReturn: readonly TriagePreviewHunk[]) => pinnedReturn)(
    params.hunks.filter(
      (hunk) => params.approvedIds.has(hunk.threadRootCommentId) && previewHunkHasDiff(hunk),
    ),
  );
}

export function pathsFromUnifiedDiff(diff: string) {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const bPath = parseDiffGitBPath(line.slice("diff --git ".length));
    if (bPath != null && bPath.length > 0) paths.push(bPath);
  }
  return ((pinnedReturn: readonly string[]) => pinnedReturn)([...new Set(paths)]);
}

function unquoteGitPath(token: string) {
  if (!token.startsWith('"'))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(
      token.length > 0 ? token : undefined,
    );
  if (!token.endsWith('"') || token.length < 2)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  let ascii = "";
  const flush = () => {
    if (bytes.length === 0) return;
    ascii += Buffer.from(bytes).toString("utf8");
    bytes.length = 0;
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      flush();
      ascii += char;
      continue;
    }
    const next = body[index + 1];
    if (next == null) return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      index += 3;
      continue;
    }
    const escaped = next === "n" ? "\n" : next === "t" ? "\t" : next;
    flush();
    ascii += escaped;
    index += 1;
  }
  flush();
  return ((pinnedReturn: string | undefined) => pinnedReturn)(ascii);
}

function readDiffGitToken(text: string, start: number) {
  if (text[start] === '"') {
    const end = findClosingQuote(text, start);
    if (end < 0) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
    const raw = unquoteGitPath(text.slice(start, end + 1));
    if (raw === undefined) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
    return ((pinnedReturn: { readonly value: string; readonly end: number } | undefined) =>
      pinnedReturn)({ value: raw, end: end + 1 });
  }
  let end = start;
  while (end < text.length && text[end] !== " ") end += 1;
  if (end === start) return ((pinnedReturn: undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: { readonly value: string; readonly end: number } | undefined) =>
    pinnedReturn)({ value: text.slice(start, end), end });
}

function parseDiffGitBPath(rest: string) {
  const aToken = readDiffGitToken(rest, 0);
  if (aToken === undefined || !aToken.value.startsWith("a/"))
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  if (rest[aToken.end] !== " ")
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  const bToken = readDiffGitToken(rest, aToken.end + 1);
  if (bToken === undefined || bToken.end !== rest.length)
    return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
  return ((pinnedReturn: string | undefined) => pinnedReturn)(stripBPrefix(bToken.value));
}

function stripBPrefix(path: string) {
  return ((pinnedReturn: string) => pinnedReturn)(path.startsWith("b/") ? path.slice(2) : path);
}

function findClosingQuote(text: string, start: number) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return ((pinnedReturn: number) => pinnedReturn)(index);
    index += 1;
  }
  return ((pinnedReturn: number) => pinnedReturn)(-1);
}

export function remapBulkPayload(params: {
  readonly payload: TriagePayload;
  readonly approvedIds: ReadonlySet<number>;
  readonly appliedCommits: ReadonlyMap<number, string>;
}) {
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
        return ((pinnedReturn: TriagePayload) => pinnedReturn)(exhaustive);
      }
    }
  }
  return ((pinnedReturn: TriagePayload) => pinnedReturn)({ verdicts });
}

export async function applyGitDiff(dir: string, diff: string) {
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

export async function resetUncommittedCheckout(dir: string) {
  await exec("git", ["reset", "--hard", "HEAD"], { cwd: dir, timeout: 30_000 });
}

export async function replayPreviewHunks(params: {
  readonly checkout: WritablePrCheckout;
  readonly hunks: readonly TriagePreviewHunk[];
  readonly applyDiff?: (dir: string, diff: string) => Promise<void>;
  readonly resetUncommitted?: (dir: string) => Promise<void>;
}) {
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
      } catch {}
      commitErrors.push({
        threadRootCommentId: hunk.threadRootCommentId,
        error: errorMessage(error),
      });
    }
  }
  return ((
    pinnedReturn:
      | {
          readonly commitByThreadRootCommentId: Map<number, string>;
          readonly commitErrors: { readonly threadRootCommentId: number; readonly error: string }[];
        }
      | Promise<{
          readonly commitByThreadRootCommentId: Map<number, string>;
          readonly commitErrors: { readonly threadRootCommentId: number; readonly error: string }[];
        }>,
  ) => pinnedReturn)({ commitByThreadRootCommentId, commitErrors });
}

export function previewApprovalSets(params: {
  readonly inventory: readonly BotFindingThread[];
  readonly preview: {
    readonly threadRootCommentIds: readonly number[];
    readonly hunks: readonly TriagePreviewHunk[];
  };
  readonly excludeIds: ReadonlySet<number>;
}) {
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
  return ((pinnedReturn: {
    readonly approvedInventory: readonly BotFindingThread[];
    readonly approvedIds: ReadonlySet<number>;
    readonly approvedHunks: readonly TriagePreviewHunk[];
    readonly excludedIds: ReadonlySet<number>;
    readonly notInPreviewIds: ReadonlySet<number>;
  }) => pinnedReturn)({
    approvedInventory,
    approvedIds,
    approvedHunks: approvedPreviewHunks({ hunks: params.preview.hunks, approvedIds }),
    excludedIds,
    notInPreviewIds,
  });
}
