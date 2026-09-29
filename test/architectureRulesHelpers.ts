const EXPORT_DECLARATION =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|type|interface|const|class)\b/;

/** Strip comments while preserving string literals (module specifiers stay intact). */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length) {
        const c = text[i]!;
        out += c;
        if (c === "\\") {
          if (i + 1 < text.length) out += text[i + 1]!;
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Strip block comments, line comments, and string literals for identifier scans. */
export function stripCommentsAndStringLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function hasForbiddenImportReference(text: string, identifier: string): boolean {
  if (identifier === "@octokit") {
    const cleaned = stripComments(text);
    return /\bfrom\s+["']@octokit\//.test(cleaned) || /\bimport\s+["']@octokit\//.test(cleaned);
  }
  if (identifier === "installationOctokit") {
    const stripped = stripCommentsAndStringLiterals(text);
    return /\binstallationOctokit\b/.test(stripped);
  }
  return false;
}

/** Value (non-`import type` / non-`export type`) references to a module, any layout. */
export function hasValueImportReference(text: string, module: string): boolean {
  const cleaned = stripComments(text);
  const specifier = module === "pg-value" ? "pg" : "pg-boss";
  const quoted = `["']${specifier}["']`;
  const clauses = cleaned.split(new RegExp(`\\bfrom\\s*${quoted}`));
  // Every split point except the last is a `from "pg"` / `from "pg-boss"` site.
  for (let i = 0; i < clauses.length - 1; i += 1) {
    const before = clauses.slice(0, i + 1).join(`from "${specifier}"`);
    const head = before.match(/[\s\S]*\b(import|export)\b([\s\S]*)$/);
    if (!head) continue;
    // head[2] is the clause after the import/export keyword; skip type-only clauses.
    if (!/^\s*type\b/.test(head[2]!)) return true;
  }
  const dynamic = new RegExp(`\\bimport\\s*\\(\\s*${quoted}\\s*\\)`);
  return dynamic.test(cleaned);
}

/** Collect full exported declaration signatures, including multi-line parameter lists. */
export function exportedSignatureTexts(text: string): string[] {
  const lines = text.split("\n");
  const signatures: string[] = [];
  let collecting = false;
  let buffer = "";
  let depth = 0;

  const updateDepth = (chunk: string): void => {
    for (const ch of chunk) {
      if (ch === "(" || ch === "{") depth += 1;
      if (ch === ")" || ch === "}") depth -= 1;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting) {
      if (!EXPORT_DECLARATION.test(trimmed)) continue;
      if (!trimmed.includes("(") && !trimmed.includes("{")) continue;
      collecting = true;
      buffer = trimmed;
      depth = 0;
      updateDepth(trimmed);
      if (depth <= 0 && (trimmed.includes(")") || trimmed.includes("}"))) {
        signatures.push(buffer);
        collecting = false;
        buffer = "";
      }
      continue;
    }

    buffer += ` ${trimmed}`;
    updateDepth(trimmed);
    if (depth <= 0) {
      signatures.push(buffer.trim());
      collecting = false;
      buffer = "";
    }
  }

  return signatures;
}

function functionParameterList(signature: string): string | null {
  const open = signature.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i]!;
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return signature.slice(open + 1, i);
    }
  }
  return null;
}

export function forbiddenExportedParam(text: string): string | undefined {
  const params = functionParameterList(text);
  const scope = params ?? text;
  if (/\btoken:\s*string\b/.test(scope)) return "token: string";
  if (/\bexpiresAtTs\b/.test(scope)) return "expiresAtTs";
  if (/\btokenExpiresAtTs\b/.test(scope)) return "tokenExpiresAtTs";
  return undefined;
}
