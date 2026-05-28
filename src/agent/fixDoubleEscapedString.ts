function unescapeDoubleEscapedSequences(value: string): string {
  const pattern = /\\([nrt"'\\])/g;
  let current = value;
  for (let pass = 0; pass < value.length; pass++) {
    const next = current.replace(pattern, (_, ch: string) => {
      switch (ch) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case '"':
          return '"';
        case "'":
          return "'";
        case "\\":
          return "\\";
        default:
          return `\\${ch}`;
      }
    });
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

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

  const unescaped = unescapeDoubleEscapedSequences(value);

  if (unescaped !== value) {
    return { text: unescaped, fixed: true };
  }

  return { text: value, fixed: false };
}
