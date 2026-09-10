const STATEMENT_START =
  /^(return|const|let|var|function|class|if|for|while|switch|try|throw|do|async|break|continue|debugger|with|import|export)\b/;

export function injectLastExpressionReturn(code: string): string {
  const trimmed = code.trimEnd();
  if (trimmed.trim().length === 0) return "return undefined";
  const lastStart = lastTopLevelStatementStart(trimmed);
  const prefix = trimmed.slice(0, lastStart);
  const last = trimmed.slice(lastStart).trim();
  if (!last) return trimmed;
  if (/^return\b/.test(last) || /^await\b/.test(last)) {
    return /^await\b/.test(last) ? `${prefix}return ${last}` : trimmed;
  }
  if (STATEMENT_START.test(last)) return trimmed;
  return `${prefix}return ${last}`;
}

function lastTopLevelStatementStart(code: string): number {
  let depth = 0;
  let lastStmtStart = 0;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    const next = code[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth += 1;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && c === ";") {
      lastStmtStart = i + 1;
    }
  }
  return lastStmtStart;
}
