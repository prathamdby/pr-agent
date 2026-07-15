const HAS_JSON_ESCAPE_CANDIDATE_RE = /\\[nrt"'\\]/;
const DRIVE_LETTER_PATH_RE = /(?:^|[^A-Za-z0-9])[A-Za-z]:\\/;
const DOUBLED_BACKSLASH_RE = /\\\\/;
const REGEX_CLASS_ESCAPE_RE = /\\[dDwWsSbB]/;
const REGEX_LITERAL_RE = /^\/(?:\\.|[^\\/])+\/[gimsuy]*$/;

function countControlChars(value: string): number {
  let count = 0;
  for (const ch of value) {
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      count += 1;
    }
  }
  return count;
}

function isAmbiguousBackslashInput(value: string): boolean {
  return (
    DOUBLED_BACKSLASH_RE.test(value) ||
    DRIVE_LETTER_PATH_RE.test(value) ||
    REGEX_CLASS_ESCAPE_RE.test(value) ||
    REGEX_LITERAL_RE.test(value)
  );
}

function tryDecodeJsonStringBody(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(`"${value}"`);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Unwrap model output where JSON string escapes were emitted literally (e.g. `\\n` instead of newline). */
export function fixDoubleEscapedString(value: string): {
  text: string;
  fixed: boolean;
} {
  if (!HAS_JSON_ESCAPE_CANDIDATE_RE.test(value)) {
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
      // fall through to single-level string-body decode
    }
  }

  if (isAmbiguousBackslashInput(value)) {
    return { text: value, fixed: false };
  }

  const decoded = tryDecodeJsonStringBody(value);
  if (decoded === null || decoded === value) {
    return { text: value, fixed: false };
  }

  if (countControlChars(decoded) <= countControlChars(value)) {
    return { text: value, fixed: false };
  }

  return { text: decoded, fixed: true };
}
