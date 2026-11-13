import { LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS } from "../../settings/index.ts";

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

export function shouldSpillToFile(bytes: number, threshold: number): boolean {
  if (!Number.isFinite(bytes) || !Number.isFinite(threshold)) return false;
  if (bytes < 0 || threshold < 0) return false;
  return bytes > threshold;
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
  readonly resumeStartLine?: number;
  readonly clampedLines?: readonly number[];
  readonly note?: string;
};

function clampLongLinePrefix(line: string): string {
  let keep = LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS;
  if (keep > 0 && keep < line.length) {
    const prev = line.charCodeAt(keep - 1);
    const next = line.charCodeAt(keep);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      keep -= 1;
    }
  }
  return line.slice(0, keep);
}

function clampLongLines(
  lines: readonly string[],
): { readonly lines: string[]; readonly clampedLines: number[] } | null {
  let clamped: string[] | null = null;
  const clampedLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > LOCAL_WORKSPACE_READ_MAX_LINE_CHARACTERS) {
      if (clamped === null) clamped = [...lines];
      const prefix = clampLongLinePrefix(line);
      const elided = line.length - prefix.length;
      clamped[index] =
        `${prefix}… [line ${index + 1} clamped: ${elided} of ${line.length} characters elided]`;
      clampedLines.push(index + 1);
    }
  }
  return clamped === null ? null : { lines: clamped, clampedLines };
}

function isMidLineByteCut(fullText: string, capped: CappedTextOutput): boolean {
  if (!capped.truncated || capped.content.length === 0) return false;
  if (capped.content.endsWith("\n")) return false;
  return fullText[capped.content.length] !== "\n";
}

function mergeClampedLines(
  prefixClamped: readonly number[],
  byteCutLine: number | undefined,
): readonly number[] {
  if (byteCutLine === undefined) return prefixClamped;
  if (prefixClamped.includes(byteCutLine)) return prefixClamped;
  return [...prefixClamped, byteCutLine].toSorted((a, b) => a - b);
}

function formatClampedLinesNote(clampedLines: readonly number[]): string {
  if (clampedLines.length === 1) {
    const line = clampedLines[0];
    return `Line ${line} was clamped to a prefix; read with startLine ${line}, maxLines 1 to inspect the full line (up to the response byte budget).`;
  }
  const preview =
    clampedLines.length <= 10
      ? clampedLines.join(", ")
      : `${clampedLines.slice(0, 10).join(", ")} (+${clampedLines.length - 10} more)`;
  return `Lines ${preview} were clamped to prefixes; read a specific line with startLine N, maxLines 1 to inspect the full line (up to the response byte budget).`;
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

  if (!hasLineWindow) {
    const clamped = clampLongLines(lines);
    const body =
      clamped === null ? text : clamped.lines.join("\n") + (text.endsWith("\n") ? "\n" : "");
    const capped = capTextOutput(body, maxResponseBytes, "response byte budget exceeded");
    const endLine = endLineForText(capped.content);
    const shownPrefixClamped = clamped?.clampedLines.filter((line) => line <= endLine) ?? [];
    const byteCutLine = endLine > 0 && isMidLineByteCut(body, capped) ? endLine : undefined;
    const clampedLines = mergeClampedLines(shownPrefixClamped, byteCutLine);
    const resumeStartLine = byteCutLine ?? endLine + 1;
    const notes: string[] = [];
    if (capped.truncated) {
      notes.push(
        `Truncated by the response byte budget at line ${endLine} of ${lines.length}. Resume with startLine ${resumeStartLine}${byteCutLine !== undefined ? " (the last shown line may be cut off)." : "."}`,
      );
    }
    if (shownPrefixClamped.length > 0) {
      notes.push(formatClampedLinesNote(shownPrefixClamped));
    }
    const note = notes.length > 0 ? notes.join(" ") : undefined;
    return {
      content: capped.content,
      size,
      startLine: 1,
      endLine,
      truncated: capped.truncated,
      returnedBytes: capped.returnedBytes,
      ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
      ...(clampedLines.length > 0 ? { clampedLines } : {}),
      ...(capped.truncated ? { resumeStartLine } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  }

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
  const singleLineRequest = window.maxLines === 1;
  const clamped = singleLineRequest ? null : clampLongLines(lines);
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

  const selectedText = selected.join("\n");
  const capped = capTextOutput(selectedText, maxResponseBytes, "response byte budget exceeded");
  if (capped.truncated && selected.length > 0) {
    endLine =
      capped.content.length === 0 ? startLine - 1 : startLine + endLineForText(capped.content) - 1;
  }

  const truncated = capped.truncated || lineWindowTruncated;
  const truncationReason =
    capped.truncationReason ?? (lineWindowTruncated ? "line window limit exceeded" : undefined);
  const shownPrefixClamped =
    clamped?.clampedLines.filter((line) => line >= startLine && line <= endLine) ?? [];
  const byteCutLine =
    endLine >= startLine && isMidLineByteCut(selectedText, capped) ? endLine : undefined;
  const clampedLines = mergeClampedLines(shownPrefixClamped, byteCutLine);

  const notes: string[] = [];
  let resumeStartLine: number | undefined;
  if (capped.truncated) {
    if (singleLineRequest) {
      const shownChars = capped.content.length;
      const totalChars = selected[0]?.length ?? 0;
      if (startLine < lines.length) {
        resumeStartLine = startLine + 1;
      }
      notes.push(
        `Line ${startLine} exceeded the response byte budget (showing ${shownChars} of ${totalChars} characters); the rest of this line cannot be reached with readWorkspaceFile.${resumeStartLine !== undefined ? ` Resume at line ${resumeStartLine} with startLine ${resumeStartLine}.` : ""}`,
      );
    } else {
      resumeStartLine = byteCutLine ?? endLine + 1;
      notes.push(
        `Truncated by the response byte budget at line ${endLine} of ${lines.length}. Resume with startLine ${resumeStartLine}${byteCutLine !== undefined ? " (the last shown line may be cut off)." : "."}`,
      );
    }
  } else if (lineWindowTruncated) {
    resumeStartLine = endLine + 1;
    notes.push(
      `Line window ended at line ${endLine} of ${lines.length}. Resume with startLine ${endLine + 1}.`,
    );
  }
  if (shownPrefixClamped.length > 0) {
    notes.push(formatClampedLinesNote(shownPrefixClamped));
  }
  const note = notes.length > 0 ? notes.join(" ") : undefined;

  return {
    content: capped.content,
    size,
    startLine,
    endLine,
    truncated,
    returnedBytes: capped.returnedBytes,
    ...(truncationReason ? { truncationReason } : {}),
    ...(clampedLines.length > 0 ? { clampedLines } : {}),
    ...(resumeStartLine !== undefined ? { resumeStartLine } : {}),
    ...(note !== undefined ? { note } : {}),
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
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    endLine += 1;
    idx = text.indexOf("\n", idx + 1);
  }
  if (text.endsWith("\n")) {
    endLine -= 1;
  }
  return Math.max(1, endLine);
}
