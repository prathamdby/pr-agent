import { createHash } from "node:crypto";
import { createAskPathGate } from "../../agent/ask/askSafety.ts";
import { createPathPolicy } from "../../agent/tools/pathPolicy.ts";
import {
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
  RECON_PACK_MAX_BYTES,
} from "../../settings/index.ts";
import { parseCommentableRightLineRanges } from "../../prWorkspace/reviewDiffIndex.ts";
import type { PathPolicy, PinnedRepositoryReader } from "../../prWorkspace/repositoryReader.ts";
import { wrapUntrustedEvidence } from "../../prompts/shared/safety.ts";

export type ReconContextPointer = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
};

export type ReconPackCreditedRead = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly clampedLines?: readonly number[];
};

export type ReconPack = {
  readonly text: string;
  readonly hash: string;
  readonly creditedLines: readonly ReconPackCreditedRead[];
};

export function emptyReconPack() {
  return ((pinnedReturn: ReconPack) => pinnedReturn)({
    text: "",
    hash: createHash("sha256").update("").digest("hex"),
    creditedLines: [],
  });
}

export function reviewPromptCacheKey(input: {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly reconPackHash: string;
}) {
  const digest = createHash("sha256")
    .update(
      `${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}:${input.reconPackHash}`,
    )
    .digest("hex");
  return ((pinnedReturn: string) => pinnedReturn)(`pr:${digest.slice(0, 32)}`);
}

type PackBlock = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly header: string;
  readonly lines: readonly string[];
  readonly clampedLines?: readonly number[];
};

async function readRangeBlock(
  reader: PinnedRepositoryReader,
  policy: PathPolicy,
  input: {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly label: string;
  },
) {
  if (input.endLine < input.startLine) return null;
  try {
    const result = await reader.readFile(input.path, policy, {
      maxFileBytes: LOCAL_WORKSPACE_MAX_FILE_BYTES,
      maxResponseBytes: LOCAL_WORKSPACE_READ_RESPONSE_BYTES,
      window: {
        startLine: input.startLine,
        maxLines: input.endLine - input.startLine + 1,
      },
    });
    if (
      result.refused ||
      "spilled" in result ||
      result.content.length === 0 ||
      result.startLine <= 0
    )
      return null;
    const lines = result.content.split("\n");
    const endLine = Math.min(result.endLine, result.startLine + lines.length - 1);
    return ((pinnedReturn: PackBlock | null) => pinnedReturn)({
      path: input.path,
      startLine: result.startLine,
      endLine,
      header: `### ${input.path} (lines ${result.startLine}-${endLine}${input.label})`,
      lines: lines.slice(0, Math.max(0, endLine - result.startLine + 1)),
      ...(result.clampedLines ? { clampedLines: result.clampedLines } : {}),
    });
  } catch {
    return ((pinnedReturn: PackBlock | null) => pinnedReturn)(null);
  }
}

function subtractCovered(covered: readonly [number, number][], startLine: number, endLine: number) {
  const segments: [number, number][] = [];
  let cursor = startLine;
  for (const [coverStart, coverEnd] of covered) {
    if (coverEnd < cursor) continue;
    if (coverStart > endLine) break;
    if (coverStart > cursor) segments.push([cursor, coverStart - 1]);
    cursor = Math.max(cursor, coverEnd + 1);
    if (cursor > endLine) break;
  }
  if (cursor <= endLine) segments.push([cursor, endLine]);
  return ((pinnedReturn: [number, number][]) => pinnedReturn)(segments);
}

export async function hydrateReconPack(params: {
  readonly reader: PinnedRepositoryReader;
  readonly pointers?: readonly ReconContextPointer[];
}) {
  const reader = params.reader;
  const gate = createAskPathGate();
  gate.addPaths(reader.changedFiles.map((file) => file.path));
  const policy = createPathPolicy(reader.agentCwd, { kind: "investigation", gate });

  const wrapOverhead = Buffer.byteLength(wrapUntrustedEvidence("recon_pack", ""), "utf8");
  const bodyBudget = RECON_PACK_MAX_BYTES - wrapOverhead;
  const credited: ReconPackCreditedRead[] = [];
  const coveredByPath = new Map<string, [number, number][]>();
  const bodyParts: string[] = [];
  let bodyBytes = 0;
  let exhausted = false;

  const noteCovered = (path: string, startLine: number, endLine: number) => {
    const ranges = coveredByPath.get(path) ?? [];
    ranges.push([startLine, endLine]);
    ranges.sort((a, b) => a[0] - b[0]);
    coveredByPath.set(path, ranges);
  };

  const appendBlock = (block: PackBlock) => {
    if (exhausted) return;
    const separatorBytes = bodyParts.length > 0 ? 2 : 0;
    const remaining =
      bodyBudget - bodyBytes - separatorBytes - Buffer.byteLength(block.header, "utf8") - 1;
    if (remaining <= 0) {
      exhausted = true;
      return;
    }
    const emitted: string[] = [];
    let emittedBytes = 0;
    for (const line of block.lines) {
      const lineBytes = Buffer.byteLength(line, "utf8") + (emitted.length > 0 ? 1 : 0);
      if (emittedBytes + lineBytes > remaining) break;
      emitted.push(line);
      emittedBytes += lineBytes;
    }
    if (emitted.length === 0) {
      exhausted = true;
      return;
    }
    const endLine = block.startLine + emitted.length - 1;
    const text = `${block.header}\n${emitted.join("\n")}`;
    bodyParts.push(text);
    bodyBytes += separatorBytes + Buffer.byteLength(text, "utf8");
    credited.push({
      path: block.path,
      startLine: block.startLine,
      endLine,
      content: emitted.join("\n"),
      ...(block.clampedLines && block.clampedLines.some((line) => line <= endLine)
        ? { clampedLines: block.clampedLines.filter((line) => line <= endLine) }
        : {}),
    });
    noteCovered(block.path, block.startLine, endLine);
    if (emitted.length < block.lines.length) exhausted = true;
  };

  const changedFiles = [...reader.changedFiles]
    .filter((file) => file.status !== "deleted")
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const changedBlocks: PackBlock[] = [];
  for (const file of changedFiles) {
    const diff = await reader.getDiffForPath(file.path);
    if (diff.availability !== "available") continue;
    for (const [startLine, endLine] of parseCommentableRightLineRanges(diff.diff)) {
      const block = await readRangeBlock(reader, policy, {
        path: file.path,
        startLine,
        endLine,
        label: "",
      });
      if (block) changedBlocks.push(block);
    }
  }
  if (changedBlocks.length > 0) {
    const heading = "## Changed files (head revision)";
    bodyParts.push(heading);
    bodyBytes += Buffer.byteLength(heading, "utf8");
  }
  for (const block of changedBlocks) appendBlock(block);

  const pointers = [...(params.pointers ?? [])].toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine,
  );
  const pointerBlocks: PackBlock[] = [];
  for (const pointer of pointers) {
    if (pointer.endLine < pointer.startLine || !policy.allows(pointer.path)) continue;
    const uncovered = subtractCovered(
      coveredByPath.get(pointer.path) ?? [],
      pointer.startLine,
      pointer.endLine,
    );
    for (const [startLine, endLine] of uncovered) {
      const block = await readRangeBlock(reader, policy, {
        path: pointer.path,
        startLine,
        endLine,
        label: pointer.symbol ? `, symbol: ${pointer.symbol}` : "",
      });
      if (block) pointerBlocks.push(block);
    }
  }
  if (pointerBlocks.length > 0) {
    const heading = "## Context pointers";
    const separatorBytes = bodyParts.length > 0 ? 2 : 0;
    if (bodyBytes + separatorBytes + Buffer.byteLength(heading, "utf8") <= bodyBudget) {
      bodyParts.push(heading);
      bodyBytes += separatorBytes + Buffer.byteLength(heading, "utf8");
    }
  }
  for (const block of pointerBlocks) appendBlock(block);

  const body = bodyParts.join("\n\n");
  const text = body.length > 0 ? wrapUntrustedEvidence("recon_pack", body) : "";
  return ((pinnedReturn: ReconPack | Promise<ReconPack>) => pinnedReturn)({
    text,
    hash: createHash("sha256").update(text).digest("hex"),
    creditedLines: credited,
  });
}
