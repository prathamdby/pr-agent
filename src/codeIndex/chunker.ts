import { createHash } from "node:crypto";
import { isIndexableSourcePath } from "../prWorkspace/symbolIndex.js";

export type CodeIndexChunk = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbolNames: readonly string[];
  readonly content: string;
  readonly contentHash: Buffer;
};

type ChunkFileContent = {
  readonly path: string;
  readonly content: string;
};

const TS_BOUNDARY =
  /^\s*(?:export\s+)?(?:(?:async\s+)?function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/;
const PY_BOUNDARY = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)\b/;
const TS_METHOD_MODIFIERS = new Set(["public", "private", "protected", "static", "async"]);

function isLineWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_" || ch === "$";
}

function isIdentPart(ch: string | undefined): boolean {
  return isIdentStart(ch) || (ch !== undefined && ch >= "0" && ch <= "9");
}

export function recognizeTsMethod(line: string): {
  readonly symbolName: string | null;
  readonly steps: number;
} {
  let i = 0;
  let steps = 0;
  const n = line.length;

  const advance = (): void => {
    i += 1;
    steps += 1;
  };

  while (i < n && isLineWs(line[i])) advance();

  const readIdent = (): string | null => {
    if (!isIdentStart(line[i])) return null;
    const start = i;
    advance();
    while (i < n && isIdentPart(line[i])) advance();
    return line.slice(start, i);
  };

  while (true) {
    const save = i;
    const word = readIdent();
    if (word === null || !TS_METHOD_MODIFIERS.has(word)) {
      i = save;
      break;
    }
    if (!isLineWs(line[i])) {
      i = save;
      break;
    }
    while (i < n && isLineWs(line[i])) advance();
  }

  const save = i;
  if (readIdent() === "function" && isLineWs(line[i])) {
    while (i < n && isLineWs(line[i])) advance();
  } else {
    i = save;
  }

  const symbolName = readIdent();
  if (symbolName === null) return { symbolName: null, steps };

  while (i < n && isLineWs(line[i])) advance();
  if (line[i] !== "(") return { symbolName: null, steps };
  advance();
  while (i < n && line[i] !== ")") advance();
  if (line[i] !== ")") return { symbolName: null, steps };
  advance();
  while (i < n && isLineWs(line[i])) advance();
  if (line[i] !== ":" && line[i] !== "{") return { symbolName: null, steps };
  return { symbolName, steps };
}

function hashContent(content: string): Buffer {
  return createHash("sha256").update(content).digest();
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return "";
  return path.slice(dot).toLowerCase();
}

function detectSymbolName(line: string, path: string): string | null {
  if (extensionOf(path) === ".py") {
    const match = PY_BOUNDARY.exec(line);
    return match?.[1] ?? null;
  }
  const match = TS_BOUNDARY.exec(line);
  if (match?.[1]) return match[1];
  return recognizeTsMethod(line).symbolName;
}

export function chunkFileContent(path: string, content: string): CodeIndexChunk[] {
  const lines = content.split("\n");
  const chunks: CodeIndexChunk[] = [];
  let chunkStart = 1;
  let chunkLines: string[] = [];
  let symbolNames: string[] = [];

  const flush = (endLine: number) => {
    if (chunkLines.length === 0) return;
    const body = chunkLines.join("\n");
    chunks.push({
      path,
      startLine: chunkStart,
      endLine,
      symbolNames: [...symbolNames],
      content: body,
      contentHash: hashContent(body),
    });
    chunkLines = [];
    symbolNames = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i] ?? "";
    const symbol = detectSymbolName(line, path);
    if (symbol && chunkLines.length > 0) {
      flush(lineNumber - 1);
      chunkStart = lineNumber;
    }
    if (symbol) symbolNames.push(symbol);
    chunkLines.push(line);
  }
  if (chunkLines.length > 0) {
    flush(chunkStart + chunkLines.length - 1);
  }
  return chunks;
}

export function chunkFiles(
  files: readonly ChunkFileContent[],
  maxChunks: number,
): { readonly chunks: readonly CodeIndexChunk[]; readonly truncated: boolean } {
  const chunks: CodeIndexChunk[] = [];
  for (const file of files) {
    if (!isIndexableSourcePath(file.path)) continue;
    const fileChunks = chunkFileContent(file.path, file.content);
    for (const chunk of fileChunks) {
      chunks.push(chunk);
      if (chunks.length >= maxChunks) {
        return { chunks, truncated: true };
      }
    }
  }
  return { chunks, truncated: false };
}
