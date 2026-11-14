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

type StatementSpan = {
  readonly start: number;
  readonly end: number;
};

export function injectLastExpressionReturn(code: string): string {
  if (code.trim().length === 0) return "return undefined";
  const span = lastTopLevelStatementSpan(code);
  if (span === null) return code;
  const prefix = code.slice(0, span.start);
  const body = code.slice(span.start, span.end);
  const suffix = code.slice(span.end);
  if (STATEMENT_START.test(body)) return code;
  return `${prefix}return ${body}${suffix}`;
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

const EXPRESSION_CONTINUATION_CHARS = new Set([
  "(",
  "[",
  "`",
  "?",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "=",
  "<",
  ">",
]);

function continuesExpression(code: string, index: number): boolean {
  const c = code[index];
  if (c != null && EXPRESSION_CONTINUATION_CHARS.has(c)) return true;
  if (c === "+" || c === "-") return code[index + 1] !== c;
  return false;
}

function lastTopLevelStatementSpan(code: string): StatementSpan | null {
  let depth = 0;
  let currentStart: number | null = null;
  let lastTokenEnd = 0;
  let lastSpan: StatementSpan | null = null;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let lastCanEnd = false;
  let lastEndsExpression = false;
  let lastWord = "";
  let word = "";
  const markToken = (start: number, end: number) => {
    if (currentStart === null) currentStart = start;
    lastTokenEnd = end;
  };
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    const next = code[i + 1];
    if (inLineComment) {
      if (c !== "\n" && c !== "\r") continue;
      inLineComment = false;
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
        lastTokenEnd = Math.min(code.length, i + 1);
        continue;
      }
      lastTokenEnd = i + 1;
      if (c === inStr) {
        inStr = null;
        lastCanEnd = true;
        lastEndsExpression = true;
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
      markToken(i, i + 1);
      inStr = c;
      word = "";
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      markToken(i, i + 1);
      depth += 1;
      lastCanEnd = false;
      lastEndsExpression = false;
      lastWord = "";
      word = "";
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      markToken(i, i + 1);
      depth -= 1;
      lastCanEnd = true;
      lastEndsExpression = c !== "}";
      lastWord = "";
      word = "";
      continue;
    }
    if (depth === 0 && c === ";") {
      if (currentStart !== null) {
        lastSpan = { start: currentStart, end: i };
        currentStart = null;
      }
      lastCanEnd = false;
      lastEndsExpression = false;
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
        if (
          j < code.length &&
          canStartStatement(code, j) &&
          !(lastEndsExpression && continuesExpression(code, j))
        ) {
          if (currentStart !== null) {
            lastSpan = { start: currentStart, end: i };
            currentStart = null;
          }
          lastCanEnd = false;
          lastEndsExpression = false;
          lastWord = "";
          word = "";
        }
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      word = "";
      continue;
    }
    if (isIdentifierChar(c)) {
      markToken(i, i + 1);
      word += c;
      lastWord = word;
      lastCanEnd = !CONTINUATION_WORDS.has(lastWord);
      lastEndsExpression = lastCanEnd;
      continue;
    }
    word = "";
    lastWord = "";
    if (c === "+" && next === "+") {
      markToken(i, i + 2);
      lastCanEnd = true;
      lastEndsExpression = true;
      i += 1;
      continue;
    }
    if (c === "-" && next === "-") {
      markToken(i, i + 2);
      lastCanEnd = true;
      lastEndsExpression = true;
      i += 1;
      continue;
    }
    markToken(i, i + 1);
    lastCanEnd = !CANNOT_END_CHARS.has(c);
    lastEndsExpression = false;
  }
  if (currentStart !== null) {
    return { start: currentStart, end: lastTokenEnd };
  }
  return lastSpan;
}
