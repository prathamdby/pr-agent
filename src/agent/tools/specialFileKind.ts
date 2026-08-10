import type { Stats } from "node:fs";

/**
 * Human name for non-regular file types whose reads would block or return
 * non-text. `stat` follows symlinks, so a symlink-to-FIFO is caught here.
 * Returns undefined for regular files.
 */
export function specialFileKind(info: Stats): string | undefined {
  if (info.isFile()) return undefined;
  if (info.isDirectory()) return "a directory";
  if (info.isFIFO()) return "a FIFO (named pipe)";
  if (info.isSocket()) return "a socket";
  if (info.isCharacterDevice()) return "a character device";
  if (info.isBlockDevice()) return "a block device";
  return "a special (non-regular) file";
}
