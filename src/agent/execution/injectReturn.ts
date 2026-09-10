const STATEMENT_START =
  /^(return|const|let|var|function|class|if|for|while|switch|try|throw|do|async|break|continue|debugger|with|import|export)\b/;

const RESTRICTED_ASI = new Set(["return", "throw", "break", "continue"]);

const CONTINUATION_WORDS = new Set([
  "instanceof",
  "in",
  "typeof",
  "new",
  "void",
  "delete",
  "yield",
  "await",
  "extends",
  "of",
  "from",
  "case",
  "else",
  "do",
  "function",
  "class",
  "async",
  "const",
  "let",
  "var",
  "import",
  "export",
]);

const CANNOT_END_CHARS = new Set([
  "=",
  ",",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "?",
  ":",
  ".",
  "<",
  ">",
  "!",
  "~",
  "(",
  "[",
  "{",
]);

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

function isIdentifierChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

function readWord(code: string, index: number): string {
  let end = index;
  while (end < code.length && isIdentifierChar(code[end] ?? "")) {
    end += 1;
  }
  return code.slice(index, end);
}

function canStartStatement(code: string, index: number): boolean {
  const c = code[index];
  if (c === "." || c === "," || c === ")" || c === "]" || c === "}" || c === ":" || c === ";") {
    return false;
  }
  const word = readWord(code, index);
  return word !== "else" && word !== "catch" && word !== "finally";
}

function lastTopLevelStatementStart(code: string): number {
  let depth = 0;
  let lastStmtStart = 0;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let lastCanEnd = false;
  let lastWord = "";
  let word = "";
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
      if (c === inStr) {
        inStr = null;
        lastCanEnd = true;
        lastWord = "";
        word = "";
      }
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
      word = "";
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth += 1;
      lastCanEnd = false;
      lastWord = "";
      word = "";
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      lastCanEnd = true;
      lastWord = "";
      word = "";
      continue;
    }
    if (depth === 0 && c === ";") {
      lastStmtStart = i + 1;
      lastCanEnd = false;
      lastWord = "";
      word = "";
      continue;
    }
    if (depth === 0 && (c === "\n" || c === "\r")) {
      if (lastCanEnd && !RESTRICTED_ASI.has(lastWord)) {
        let j = i + 1;
        if (c === "\r" && next === "\n") {
          j = i + 2;
        }
        while (j < code.length && (code[j] === " " || code[j] === "\t")) {
          j += 1;
        }
        if (j < code.length && canStartStatement(code, j)) {
          lastStmtStart = j;
        }
      }
      continue;
    }
    if (c === " " || c === "\t") {
      word = "";
      continue;
    }
    if (isIdentifierChar(c)) {
      word += c;
      lastWord = word;
      lastCanEnd = !CONTINUATION_WORDS.has(lastWord);
      continue;
    }
    word = "";
    lastWord = "";
    if (c === "+" && next === "+") {
      lastCanEnd = true;
      i += 1;
      continue;
    }
    if (c === "-" && next === "-") {
      lastCanEnd = true;
      i += 1;
      continue;
    }
    lastCanEnd = !CANNOT_END_CHARS.has(c);
  }
  return lastStmtStart;
}
