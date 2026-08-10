import { LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS } from "../../settings/index.js";

export type CappedTextOutput = {
  readonly content: string;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly truncationReason?: string;
};

export function capTextOutput(
  text: string,
  maxBytes: number,
  truncationReason: string,
): CappedTextOutput {
  const returnedBytes = Buffer.byteLength(text, "utf8");
  if (returnedBytes <= maxBytes) {
    return { content: text, truncated: false, returnedBytes };
  }

  const buf = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  const content = buf.subarray(0, end).toString("utf8");
  return {
    content,
    truncated: true,
    returnedBytes: Buffer.byteLength(content, "utf8"),
    truncationReason,
  };
}

export type FileReadWindowParams = {
  readonly startLine?: number;
  readonly maxLines?: number;
};

export type FileReadOutput = {
  readonly content: string;
  readonly size: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly truncationReason?: string;
  /** Line to pass as startLine on the next read; present on every truncation. */
  readonly resumeStartLine?: number;
  /**
   * File line numbers whose contents were elided by the clamp. These lines
   * were never shown, so they must not count as read evidence.
   */
  readonly clampedLines?: readonly number[];
  readonly note?: string;
};

/**
 * A single minified line must not displace the whole response budget: lines
 * longer than LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS are replaced by a
 * marker naming the file line number and the original length. Markers are
 * single-line so line numbering is preserved. Runs before window slicing and
 * before the byte budget. Returns null when nothing was clamped so callers
 * can keep the original text byte-identical.
 */
function clampLongLines(
  lines: readonly string[],
): { readonly lines: string[]; readonly clampedLines: number[] } | null {
  let clamped: string[] | null = null;
  const clampedLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS) {
      if (clamped === null) clamped = [...lines];
      clamped[index] = `[line ${index + 1} clamped: ${line.length} characters elided]`;
      clampedLines.push(index + 1);
    }
  }
  return clamped === null ? null : { lines: clamped, clampedLines };
}

export function readTextWithOutputBudget(
  text: string,
  maxResponseBytes: number,
  window?: FileReadWindowParams,
): FileReadOutput {
  const size = Buffer.byteLength(text, "utf8");
  if (size === 0) {
    return { content: "", size, startLine: 0, endLine: 0, truncated: false, returnedBytes: 0 };
  }
  const hasLineWindow = window?.startLine != null || window?.maxLines != null;
  const lines = splitLines(text);
  const clamped = clampLongLines(lines);

  if (!hasLineWindow) {
    // Keep uncapped reads byte-identical; only a clamp reassembles the text.
    const body =
      clamped === null ? text : clamped.lines.join("\n") + (text.endsWith("\n") ? "\n" : "");
    const capped = capTextOutput(body, maxResponseBytes, "response byte budget exceeded");
    const endLine = endLineForText(capped.content);
    const shownClamped = clamped?.clampedLines.filter((line) => line <= endLine) ?? [];
    return {
      content: capped.content,
      size,
      startLine: 1,
      endLine,
      truncated: capped.truncated,
      returnedBytes: capped.returnedBytes,
      ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
      ...(shownClamped.length > 0 ? { clampedLines: shownClamped } : {}),
      // A byte-cap cut can land mid-line, so the next read resumes ON the
      // last shown line instead of silently skipping its tail.
      ...(capped.truncated
        ? {
            resumeStartLine: endLine,
            note: `Truncated by the response byte budget at line ${endLine} of ${lines.length}. Resume with startLine ${endLine} (the last shown line may be cut off).`,
          }
        : {}),
    };
  }

  // Name the dead end: silent empty content is indistinguishable from a
  // broken tool, so the model re-reads or widens the window to find out.
  if (window.startLine != null && window.startLine > lines.length) {
    return {
      content: "",
      size,
      startLine: 0,
      endLine: 0,
      truncated: false,
      returnedBytes: 0,
      note: `startLine ${window.startLine} is beyond the end of the file (${lines.length} lines total). Retry with startLine <= ${lines.length}.`,
    };
  }
  const budgetedLines = clamped?.lines ?? lines;
  const startIdx = Math.max(0, Math.min(budgetedLines.length, (window.startLine ?? 1) - 1));
  const endIdxExclusive =
    window.maxLines == null
      ? budgetedLines.length
      : Math.min(budgetedLines.length, startIdx + Math.max(0, window.maxLines));
  const selected = budgetedLines.slice(startIdx, endIdxExclusive);
  const startLine = lines.length === 0 ? 0 : startIdx + 1;
  let endLine = lines.length === 0 ? 0 : startIdx + selected.length;
  const lineWindowTruncated = endIdxExclusive < lines.length;

  const capped = capTextOutput(
    selected.join("\n"),
    maxResponseBytes,
    "response byte budget exceeded",
  );
  if (capped.truncated && selected.length > 0) {
    endLine = startLine + endLineForText(capped.content) - 1;
  }

  const truncated = capped.truncated || lineWindowTruncated;
  const truncationReason =
    capped.truncationReason ?? (lineWindowTruncated ? "line window limit exceeded" : undefined);
  const shownClamped =
    clamped?.clampedLines.filter((line) => line >= startLine && line <= endLine) ?? [];

  return {
    content: capped.content,
    size,
    startLine,
    endLine,
    truncated,
    returnedBytes: capped.returnedBytes,
    ...(truncationReason ? { truncationReason } : {}),
    ...(shownClamped.length > 0 ? { clampedLines: shownClamped } : {}),
    ...(capped.truncated
      ? {
          resumeStartLine: endLine,
          note: `Truncated by the response byte budget at line ${endLine} of ${lines.length}. Resume with startLine ${endLine} (the last shown line may be cut off).`,
        }
      : lineWindowTruncated
        ? {
            resumeStartLine: endLine + 1,
            note: `Line window ended at line ${endLine} of ${lines.length}. Resume with startLine ${endLine + 1}.`,
          }
        : {}),
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [""];
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function endLineForText(text: string): number {
  if (text.length === 0) return 0;
  let endLine = 1;
  for (const char of text) {
    if (char === "\n") endLine += 1;
  }
  if (text.endsWith("\n")) {
    endLine -= 1;
  }
  return Math.max(1, endLine);
}
