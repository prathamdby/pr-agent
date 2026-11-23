const HAS_JSON_ESCAPE_CANDIDATE_RE = /\\[nrt"'\\]/;
const DRIVE_LETTER_PATH_RE = /(?:^|[^A-Za-z0-9])[A-Za-z]:\\/;
const DOUBLED_BACKSLASH_RE = /\\\\/;
const REGEX_CLASS_ESCAPE_RE = /\\[dDwWsSbB]/;
const REGEX_LITERAL_RE = /^\/(?:\\.|[^\\/])+\/[gimsuy]*$/;

function countControlChars(value: string) {
  let count = 0;
  for (const ch of value) {
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      count += 1;
    }
  }
  return ((pinnedReturn: number) => pinnedReturn)(count);
}

function isAmbiguousBackslashInput(value: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    DOUBLED_BACKSLASH_RE.test(value) ||
      DRIVE_LETTER_PATH_RE.test(value) ||
      REGEX_CLASS_ESCAPE_RE.test(value) ||
      REGEX_LITERAL_RE.test(value),
  );
}

function jsonStringBody(value: string) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? "";
    if (ch === "\\") {
      const next = value[index + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      out += `\\${next}`;
      index += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\"';
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    if ((ch.codePointAt(0) ?? 0) < 0x20) {
      return null;
    }
    out += ch;
  }
  return out;
}

function tryDecodeJsonStringBody(value: string) {
  try {
    const parsed: unknown = JSON.parse(`"${value}"`);
    return ((pinnedReturn: string | null) => pinnedReturn)(
      typeof parsed === "string" ? parsed : null,
    );
  } catch {
    return ((pinnedReturn: string | null) => pinnedReturn)(null);
  }
}

export function decodeMermaidNewlineEscapes(value: string) {
  if (!HAS_JSON_ESCAPE_CANDIDATE_RE.test(value) || isAmbiguousBackslashInput(value)) {
    return { text: value, fixed: false };
  }
  const body = jsonStringBody(value);
  if (body === null) return { text: value, fixed: false };
  try {
    const parsed: unknown = JSON.parse(`"${body}"`);
    if (typeof parsed !== "string" || parsed === value) return { text: value, fixed: false };
    if (countControlChars(parsed) <= countControlChars(value)) return { text: value, fixed: false };
    return { text: parsed, fixed: true };
  } catch {
    return { text: value, fixed: false };
  }
}

export function fixDoubleEscapedString(value: string) {
  if (!HAS_JSON_ESCAPE_CANDIDATE_RE.test(value)) {
    return ((pinnedReturn: { text: string; fixed: boolean }) => pinnedReturn)({
      text: value,
      fixed: false,
    });
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed !== value) {
        return ((pinnedReturn: { text: string; fixed: boolean }) => pinnedReturn)({
          text: parsed,
          fixed: true,
        });
      }
    } catch {}
  }

  if (isAmbiguousBackslashInput(value)) {
    return ((pinnedReturn: { text: string; fixed: boolean }) => pinnedReturn)({
      text: value,
      fixed: false,
    });
  }

  const decoded = tryDecodeJsonStringBody(value);
  if (decoded === null || decoded === value) {
    return ((pinnedReturn: { text: string; fixed: boolean }) => pinnedReturn)({
      text: value,
      fixed: false,
    });
  }

  if (countControlChars(decoded) <= countControlChars(value)) {
    return ((pinnedReturn: { text: string; fixed: boolean }) => pinnedReturn)({
      text: value,
      fixed: false,
    });
  }

  return ((pinnedReturn: { text: string; fixed: boolean }) => pinnedReturn)({
    text: decoded,
    fixed: true,
  });
}
