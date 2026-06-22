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
};

export function readTextWithOutputBudget(
  text: string,
  maxResponseBytes: number,
  window?: FileReadWindowParams,
): FileReadOutput {
  const size = Buffer.byteLength(text, "utf8");
  const hasLineWindow = window?.startLine != null || window?.maxLines != null;

  if (!hasLineWindow) {
    const capped = capTextOutput(text, maxResponseBytes, "response byte budget exceeded");
    return {
      content: capped.content,
      size,
      startLine: size === 0 ? 0 : 1,
      endLine: endLineForText(capped.content),
      truncated: capped.truncated,
      returnedBytes: capped.returnedBytes,
      ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
    };
  }

  const lines = splitLines(text);
  const startIdx = Math.max(0, Math.min(lines.length, (window.startLine ?? 1) - 1));
  const endIdxExclusive =
    window.maxLines == null
      ? lines.length
      : Math.min(lines.length, startIdx + Math.max(0, window.maxLines));
  const selected = lines.slice(startIdx, endIdxExclusive);
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

  return {
    content: capped.content,
    size,
    startLine,
    endLine,
    truncated,
    returnedBytes: capped.returnedBytes,
    ...(truncationReason ? { truncationReason } : {}),
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
