import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";

export const MISSING_FROM_CHECKOUT_REASON = "Path is missing from the checkout.";

export type WorkspaceTextFileRefusal = {
  readonly refused: true;
  readonly refusalKind: "missing" | "special" | "too-large";
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
  const content = await readFile(fullPath, "utf8");
  return {
    size: target.size,
    content,
    ...(target.size === 0 ? { note: "File is empty (0 bytes)." } : {}),
  };
}
