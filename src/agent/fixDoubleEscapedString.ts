/** Unwrap model output where JSON string escapes were emitted literally (e.g. `\\n` instead of newline). */
export function fixDoubleEscapedString(value: string): { text: string; fixed: boolean } {
  if (!/\\[nrt"'\\]/.test(value)) {
    return { text: value, fixed: false };
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed !== value) {
        return { text: parsed, fixed: true };
      }
    } catch {
      // fall through to manual unescape
    }
  }

  const unescaped = value
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");

  if (unescaped !== value) {
    return { text: unescaped, fixed: true };
  }

  return { text: value, fixed: false };
}
