export function firstNonEmptyLine(text: string): string {
  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const atEnd = i === text.length;
    const ch = atEnd ? "" : text[i];
    if (!atEnd && ch !== "\n" && ch !== "\r") continue;

    const line = text.slice(lineStart, i);
    if (line.trim().length > 0) return line;

    if (ch === "\r" && text[i + 1] === "\n") i += 1;
    lineStart = i + 1;
  }
  return "";
}
