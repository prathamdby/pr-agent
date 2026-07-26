import { createHash } from "node:crypto";
import { isIndexableSourcePath } from "../prWorkspace/symbolIndex.js";
import { CODE_INDEX_CHUNKER_VERSION } from "../settings/index.js";

export type CodeIndexChunk = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbolNames: readonly string[];
  readonly content: string;
  readonly contentHash: Buffer;
};

export type ChunkFileContent = {
  readonly path: string;
  readonly content: string;
};

const TS_BOUNDARY =
  /^\s*(?:export\s+)?(?:(?:async\s+)?function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/;
const TS_METHOD =
  /^\s*(?:public|private|protected|static|async|\s)*(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::|{)/;
const PY_BOUNDARY = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)\b/;

function hashContent(content: string): Buffer {
  return createHash("sha256").update(content).digest();
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return "";
  return path.slice(dot).toLowerCase();
}

function boundaryMatchers(path: string): Array<RegExp> {
  if (extensionOf(path) === ".py") return [PY_BOUNDARY];
  return [TS_BOUNDARY, TS_METHOD];
}

function detectSymbolName(line: string, matchers: readonly RegExp[]): string | null {
  for (const pattern of matchers) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function chunkFileContent(path: string, content: string): CodeIndexChunk[] {
  const matchers = boundaryMatchers(path);
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
    const symbol = detectSymbolName(line, matchers);
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

export function codeIndexChunkerVersion(): string {
  return CODE_INDEX_CHUNKER_VERSION;
}
