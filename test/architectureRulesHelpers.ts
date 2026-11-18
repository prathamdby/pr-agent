const EXPORT_DECLARATION =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|type|interface|const|class)\b/;

export type CodeRow = {
  id: string;
  kind:
    | "module"
    | "identifier"
    | "process-env"
    | "escape-call"
    | "sql-status"
    | "console-call"
    | "call"
    | "member-call"
    | "optional-field"
    | "fence-literal"
    | "github-list";
  specifierPrefix?: string;
  identifier?: string;
  identifiers?: string[];
  receiver?: string;
  method?: string;
  skipTypeOnly?: boolean;
  allow: string[];
  mustCatch: string[];
};

function specifierMatches(row: CodeRow, specifier: string) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    row.specifierPrefix != null &&
      (specifier === row.specifierPrefix || specifier.startsWith(row.specifierPrefix)),
  );
}

function assignsWorkItemStatus(text: string) {
  if (!/update\s+agent_work_items/i.test(text))
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const setAt = text.search(/\bset\b/i);
  if (setAt < 0) return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const afterSet = text.slice(setAt);
  const whereAt = afterSet.search(/\bwhere\b/i);
  const clause = whereAt < 0 ? afterSet : afterSet.slice(0, whereAt);
  return ((pinnedReturn: boolean) => pinnedReturn)(/\bstatus\s*=/.test(clause));
}

export function sourceMatchesCodeRow(row: CodeRow, fileName: string, text: string) {
  void fileName;
  let typeOnlyStatement = false;
  let lastWord = "";
  let pendingSpecifier = false;
  let restChain = false;
  let sawDot = false;
  let i = 0;

  const hitSpecifier = (specifier: string) => {
    if (row.kind !== "module") return ((pinnedReturn: boolean) => pinnedReturn)(false);
    if (row.skipTypeOnly && typeOnlyStatement)
      return ((pinnedReturn: boolean) => pinnedReturn)(false);
    return ((pinnedReturn: boolean) => pinnedReturn)(specifierMatches(row, specifier));
  };

  while (i < text.length) {
    const ch = text[i];
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
      let body = "";
      while (i < text.length) {
        const c = text[i];
        if (c === "\\") {
          body += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        if (quote === "`" && c === "$" && text[i + 1] === "{") {
          i += 2;
          let depth = 1;
          const start = i;
          let nested: string | null = null;
          while (i < text.length && depth > 0) {
            const current = text[i];
            if (nested) {
              if (current === "\\") {
                i += 2;
                continue;
              }
              if (current === nested) nested = null;
              i += 1;
              continue;
            }
            if (current === '"' || current === "'" || current === "`") {
              nested = current;
              i += 1;
              continue;
            }
            if (current === "{") depth += 1;
            else if (current === "}") depth -= 1;
            if (depth > 0) i += 1;
          }
          if (sourceMatchesCodeRow(row, fileName, text.slice(start, i)))
            return ((pinnedReturn: boolean) => pinnedReturn)(true);
          i += 1;
          continue;
        }
        body += c;
        i += 1;
      }
      if (pendingSpecifier && hitSpecifier(body))
        return ((pinnedReturn: boolean) => pinnedReturn)(true);
      if (row.kind === "sql-status" && assignsWorkItemStatus(body))
        return ((pinnedReturn: boolean) => pinnedReturn)(true);
      pendingSpecifier = false;
      lastWord = "";
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === ";") {
      typeOnlyStatement = false;
      pendingSpecifier = false;
      lastWord = "";
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) i += 1;
      const word = text.slice(start, i);
      if (word === "import" || word === "export") {
        typeOnlyStatement = /^\s+type\b/.test(text.slice(i));
      }
      if (word === "from" || word === "require") pendingSpecifier = true;
      if (word === "import") pendingSpecifier = true;
      if (row.kind === "identifier" && word === row.identifier)
        return ((pinnedReturn: boolean) => pinnedReturn)(true);
      if (row.kind === "process-env" && word === "process") {
        const rest = text.slice(i);
        if (/^\s*\.\s*env\b/.test(rest) || /^\s*\[\s*["']env["']\s*\]/.test(rest))
          return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (row.kind === "escape-call" && word === "escape" && lastWord !== "function") {
        if (/^\s*(?:<[^;\n]*>)?\s*\(/.test(text.slice(i)))
          return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (row.kind === "console-call" && word === "console") {
        if (/^\s*\.\s*(?:log|error|warn|info|debug|trace)\s*\(/.test(text.slice(i)))
          return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (row.kind === "call" && word === row.identifier && lastWord !== "function") {
        if (/^\s*\(/.test(text.slice(i))) return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (row.kind === "member-call" && word === row.method && lastWord === row.receiver) {
        if (/^\s*\(/.test(text.slice(i))) return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (row.kind === "optional-field" && (row.identifiers ?? []).includes(word)) {
        if (/^\s*\?/.test(text.slice(i))) return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (row.kind === "fence-literal" && word === "kind") {
        if (/^\s*:\s*["'](?:unleased|unfenced)["']/.test(text.slice(i)))
          return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (
        row.kind === "github-list" &&
        restChain &&
        word.startsWith("list") &&
        /^\s*\(/.test(text.slice(i))
      ) {
        return ((pinnedReturn: boolean) => pinnedReturn)(true);
      }
      if (sawDot && word === "rest") restChain = true;
      else if (!/^\s*\./.test(text.slice(i))) restChain = false;
      sawDot = false;
      lastWord = word;
      continue;
    }
    if (ch === "(" && lastWord === "import") pendingSpecifier = true;
    if (ch === ".") sawDot = true;
    else if (!/\s/.test(ch)) sawDot = false;
    i += 1;
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(false);
}

export function isCodeRowAllowed(rel: string, allow: readonly string[]) {
  return ((pinnedReturn: boolean) => pinnedReturn)(
    allow.some((pattern) => (pattern.endsWith("/") ? rel.startsWith(pattern) : rel === pattern)),
  );
}

export function exportedSignatureTexts(text: string) {
  const lines = text.split("\n");
  const signatures: string[] = [];
  let collecting = false;
  let buffer = "";
  let depth = 0;

  const updateDepth = (chunk: string) => {
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

  return ((pinnedReturn: string[]) => pinnedReturn)(signatures);
}

function functionParameterList(signature: string) {
  const open = signature.indexOf("(");
  if (open < 0) return ((pinnedReturn: string | null) => pinnedReturn)(null);
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0)
        return ((pinnedReturn: string | null) => pinnedReturn)(signature.slice(open + 1, i));
    }
  }
  return ((pinnedReturn: string | null) => pinnedReturn)(null);
}

export function forbiddenExportedParam(text: string) {
  const params = functionParameterList(text);
  const scope = params ?? text;
  if (/\btoken:\s*string\b/.test(scope))
    return ((pinnedReturn: string | undefined) => pinnedReturn)("token: string");
  if (/\bexpiresAtTs\b/.test(scope))
    return ((pinnedReturn: string | undefined) => pinnedReturn)("expiresAtTs");
  if (/\btokenExpiresAtTs\b/.test(scope))
    return ((pinnedReturn: string | undefined) => pinnedReturn)("tokenExpiresAtTs");
  return ((pinnedReturn: string | undefined) => pinnedReturn)(undefined);
}
