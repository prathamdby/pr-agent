import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_WORKSPACE_READ_SPILL_TAIL_BYTES,
  LOCAL_WORKSPACE_READ_SPILL_THRESHOLD_BYTES,
} from "../../settings/index.js";
import {
  readTextWithOutputBudget,
  shouldSpillToFile,
  type FileReadOutput,
  type FileReadWindowParams,
} from "./toolOutputBudget.js";

export const MISSING_FROM_CHECKOUT_REASON = "Path is missing from the checkout.";
export const BINARY_FILE_REASON = "Binary file cannot be read as text.";

/** Sample size for the `\0` sniff that names binary files instead of returning mojibake. */
const BINARY_SAMPLE_BYTES = 8192;

export type WorkspaceTextFileRefusal = {
  readonly refused: true;
  readonly refusalKind: "missing" | "special" | "too-large" | "binary";
  readonly reason: string;
};

export type WorkspaceTextFileReadResult =
  | WorkspaceTextFileRefusal
  | {
      readonly refused?: undefined;
      readonly size: number;
      readonly content: string;
      readonly note?: string;
    };

type StatReadTarget =
  | WorkspaceTextFileRefusal
  | { readonly refused?: undefined; readonly size: number };

/**
 * Human name for non-regular file types whose reads would block or return
 * non-text. `stat` follows symlinks, so a symlink-to-FIFO is caught here.
 * Returns undefined for regular files.
 */
function specialFileKind(info: Stats): string | undefined {
  if (info.isFile()) return undefined;
  if (info.isDirectory()) return "a directory";
  if (info.isFIFO()) return "a FIFO (named pipe)";
  if (info.isSocket()) return "a socket";
  if (info.isCharacterDevice()) return "a character device";
  if (info.isBlockDevice()) return "a block device";
  return "a special (non-regular) file";
}

/**
 * Stat-level classification shared by every workspace read tool. Names why
 * a path cannot be read instead of reporting everything as missing: a FIFO
 * or directory that exists but can never be read sends the model spelunking.
 */
async function statReadTarget(fullPath: string, maxFileBytes: number): Promise<StatReadTarget> {
  const info = await stat(fullPath).catch(() => null);
  if (!info) {
    return { refused: true, refusalKind: "missing", reason: MISSING_FROM_CHECKOUT_REASON };
  }
  const fileKind = specialFileKind(info);
  if (fileKind !== undefined) {
    return {
      refused: true,
      refusalKind: "special",
      reason: `Path is ${fileKind}, not a regular file; no read was attempted.`,
    };
  }
  if (info.size > maxFileBytes) {
    return {
      refused: true,
      refusalKind: "too-large",
      reason: `File exceeds ${maxFileBytes} byte read limit.`,
    };
  }
  return { size: info.size };
}

/**
 * The classification above as a refusal-or-null guard for callers that do
 * not read the file themselves (e.g. git blame, which must never open a
 * FIFO either).
 */
export async function refuseWorkspaceTextFileRead(
  fullPath: string,
  maxFileBytes: number,
): Promise<WorkspaceTextFileRefusal | null> {
  const target = await statReadTarget(fullPath, maxFileBytes);
  return target.refused ? target : null;
}

/**
 * Strip a leading BOM and normalize CRLF to LF at the single decode point,
 * so line numbers and content hashes agree with what diff and blame report.
 */
export function normalizeTextFileEncoding(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/**
 * Guarded read of a workspace text file: the refusal above, or the decoded
 * content. Empty files carry a note — silent empty content is
 * indistinguishable from a broken tool, so the model re-reads to find out.
 */
export async function readWorkspaceTextFile(
  fullPath: string,
  maxFileBytes: number,
): Promise<WorkspaceTextFileReadResult> {
  const target = await statReadTarget(fullPath, maxFileBytes);
  if (target.refused) {
    return target;
  }
  const content = normalizeTextFileEncoding(await readFile(fullPath, "utf8"));
  return {
    size: target.size,
    content,
    ...(target.size === 0 ? { note: "File is empty (0 bytes)." } : {}),
  };
}

export type BudgetedWorkspaceTextFileRead =
  | WorkspaceTextFileRefusal
  | (FileReadOutput & { readonly refused?: undefined });

/**
 * The one budgeted read path every feature shares: stat-level refusal, then
 * the binary sniff, then the response budget with its per-line clamp, line
 * windows, and precomputed resume offsets. Reads whose full size is strictly
 * over the spill threshold AND whose budgeted read truncated spill the full
 * text to a session file and carry a tail inline. The 1MB-style file-size
 * refusal stays the outer ceiling; the response budget is the inner one.
 */
export async function readBudgetedWorkspaceTextFile(
  fullPath: string,
  opts: {
    readonly maxFileBytes: number;
    readonly maxResponseBytes: number;
    readonly window?: FileReadWindowParams;
    readonly spillTailBytes?: number;
    readonly spillScope?: TextSpillScope;
  },
): Promise<BudgetedWorkspaceTextFileRead | SpilledWorkspaceTextFileRead> {
  const result = await readWorkspaceTextFile(fullPath, opts.maxFileBytes);
  if (result.refused) {
    return result;
  }
  if (result.content.slice(0, BINARY_SAMPLE_BYTES).includes("\0")) {
    return { refused: true, refusalKind: "binary", reason: BINARY_FILE_REASON };
  }
  const readOutput = readTextWithOutputBudget(result.content, opts.maxResponseBytes, opts.window);
  const note = [result.note, readOutput.note].filter(Boolean).join(" ");
  const budgeted: BudgetedWorkspaceTextFileRead = {
    ...readOutput,
    ...(note ? { note } : {}),
  };
  if (budgeted.refused || !budgeted.truncated || opts.spillScope === undefined) {
    return budgeted;
  }
  if (!shouldSpillToFile(budgeted.size, LOCAL_WORKSPACE_READ_SPILL_THRESHOLD_BYTES)) {
    return budgeted;
  }
  return spillTextToSessionFile(result.content, opts.spillScope, {
    tailBytes: opts.spillTailBytes,
  });
}

/**
 * Scope pinning a spill file to one tool call. Sanitized into the filename;
 * a random suffix keeps repeated calls for the same pair unique.
 */
export type TextSpillScope = {
  readonly workItemId: string;
  readonly toolCall: string;
};

/**
 * Overflow envelope for an over-threshold read. `path`/`spillPath` name the
 * session-scoped spill file under the OS tmpdir holding the FULL text;
 * `tail` carries the last bytes inline so the caller keeps context without
 * spending the full token cost. `truncated: true` preserves
 * cannot-prove-absence semantics: the spill file itself is NOT read evidence.
 * A finding may only cite a path/line from a range actually read back through
 * `readWorkspaceFile` with explicit startLine/maxLines (ledger-recorded).
 */
export type SpilledWorkspaceTextFileRead = {
  readonly refused?: undefined;
  readonly spilled: true;
  readonly path: string;
  readonly spillPath: string;
  readonly size: number;
  readonly tail: string;
  readonly truncated: true;
  readonly note: string;
};

/**
 * Write an over-threshold output to a session-scoped file under the OS
 * tmpdir, unique per work item + tool call (random suffix). Returns the
 * spill envelope; never records evidence.
 */
export async function spillTextToSessionFile(
  text: string,
  scope: TextSpillScope,
  opts?: { readonly tailBytes?: number },
): Promise<SpilledWorkspaceTextFileRead> {
  const tailBytes = opts?.tailBytes ?? LOCAL_WORKSPACE_READ_SPILL_TAIL_BYTES;
  const size = Buffer.byteLength(text, "utf8");
  const cleanWorkItem = scope.workItemId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const cleanToolCall = scope.toolCall.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const fileName = `pr-agent-read-spill-${cleanWorkItem.length > 0 ? cleanWorkItem : "call"}-${cleanToolCall.length > 0 ? cleanToolCall : "call"}-${randomUUID().slice(0, 8)}.txt`;
  const spillPath = join(tmpdir(), fileName);
  await writeFile(spillPath, text, "utf8");
  // Last tailBytes without splitting a UTF-8 sequence: walk the cut forward
  // past continuation bytes (10xxxxxx) so the tail stays valid UTF-8.
  const buf = Buffer.from(text, "utf8");
  let tail: string;
  if (buf.length <= tailBytes) {
    tail = text;
  } else {
    let start = buf.length - tailBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
      start += 1;
    }
    tail = buf.subarray(start).toString("utf8");
  }
  return {
    spilled: true,
    path: spillPath,
    spillPath,
    size,
    tail,
    truncated: true,
    note: `Output (${size} bytes) exceeded the spill threshold; full text spilled to ${spillPath}. Spilled content is not read evidence — re-read the source path via readWorkspaceFile with explicit startLine/maxLines before citing any line in a finding.`,
  };
}
