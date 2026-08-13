import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  readTextWithOutputBudget,
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

type WorkspaceTextFileContent = {
  size: number;
  content: string;
  note?: string;
  refused?: undefined;
};

type MutableFileReadOutput = {
  -readonly [K in keyof FileReadOutput]: FileReadOutput[K];
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
  const result: WorkspaceTextFileContent = {
    size: target.size,
    content,
  };
  if (target.size === 0) result.note = "File is empty (0 bytes).";
  return result;
}

export type BudgetedWorkspaceTextFileRead =
  | WorkspaceTextFileRefusal
  | (FileReadOutput & { readonly refused?: undefined });

/**
 * The one budgeted read path every feature shares: stat-level refusal, then
 * the binary sniff, then the response budget with its per-line clamp, line
 * windows, and precomputed resume offsets. The 1MB-style file-size refusal
 * stays the outer ceiling; the response budget is the inner one.
 */
export async function readBudgetedWorkspaceTextFile(
  fullPath: string,
  opts: {
    readonly maxFileBytes: number;
    readonly maxResponseBytes: number;
    readonly window?: FileReadWindowParams;
  },
): Promise<BudgetedWorkspaceTextFileRead> {
  const result = await readWorkspaceTextFile(fullPath, opts.maxFileBytes);
  if (result.refused) {
    return result;
  }
  if (result.content.slice(0, BINARY_SAMPLE_BYTES).includes("\0")) {
    return { refused: true, refusalKind: "binary", reason: BINARY_FILE_REASON };
  }
  const readOutput = readTextWithOutputBudget(result.content, opts.maxResponseBytes, opts.window);
  const note = [result.note, readOutput.note].filter(Boolean).join(" ");
  const output: MutableFileReadOutput = { ...readOutput };
  if (note) output.note = note;
  return output;
}
