import {
  LOCAL_WORKSPACE_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
  LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS,
} from "../settings/index.js";

export type SymbolKind = "function" | "class" | "type" | "variable";

export type SymbolIndexEntry = {
  readonly path: string;
  readonly line: number;
  readonly kind: SymbolKind;
};

export type SymbolIndex = {
  readonly byName: ReadonlyMap<string, readonly SymbolIndexEntry[]>;
  readonly symbolCount: number;
};

export type SymbolIndexStatus =
  | { readonly available: true; readonly symbolCount: number }
  | { readonly available: false };

export type SymbolIndexReadFile = (path: string) => Promise<string | null>;

const INDEXABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

const TS_FUNCTION = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/;
const TS_CLASS = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/;
const TS_TYPE = /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)\b/;
const TS_VARIABLE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/;
const PY_FUNCTION = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\b/;
const PY_CLASS = /^\s*class\s+([A-Za-z_][\w]*)\b/;

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return "";
  return path.slice(dot).toLowerCase();
}

export function isIndexableSourcePath(path: string): boolean {
  return INDEXABLE_EXTENSIONS.has(extensionOf(path));
}

function addEntry(
  byName: Map<string, SymbolIndexEntry[]>,
  name: string,
  entry: SymbolIndexEntry,
  maxSymbols: number,
  symbolCount: { value: number },
): boolean {
  if (symbolCount.value >= maxSymbols) return false;
  const existing = byName.get(name);
  if (existing) {
    existing.push(entry);
  } else {
    byName.set(name, [entry]);
  }
  symbolCount.value += 1;
  return true;
}

function indexTypeScriptLine(
  byName: Map<string, SymbolIndexEntry[]>,
  path: string,
  lineNumber: number,
  line: string,
  maxSymbols: number,
  symbolCount: { value: number },
): boolean {
  const matchers: Array<[RegExp, SymbolKind]> = [
    [TS_FUNCTION, "function"],
    [TS_CLASS, "class"],
    [TS_TYPE, "type"],
    [TS_VARIABLE, "variable"],
  ];
  for (const [pattern, kind] of matchers) {
    const match = pattern.exec(line);
    if (!match?.[1]) continue;
    if (!addEntry(byName, match[1], { path, line: lineNumber, kind }, maxSymbols, symbolCount)) {
      return false;
    }
    return true;
  }
  return true;
}

function indexPythonLine(
  byName: Map<string, SymbolIndexEntry[]>,
  path: string,
  lineNumber: number,
  line: string,
  maxSymbols: number,
  symbolCount: { value: number },
): boolean {
  const matchers: Array<[RegExp, SymbolKind]> = [
    [PY_FUNCTION, "function"],
    [PY_CLASS, "class"],
  ];
  for (const [pattern, kind] of matchers) {
    const match = pattern.exec(line);
    if (!match?.[1]) continue;
    if (!addEntry(byName, match[1], { path, line: lineNumber, kind }, maxSymbols, symbolCount)) {
      return false;
    }
    return true;
  }
  return true;
}

function indexFileContent(
  byName: Map<string, SymbolIndexEntry[]>,
  path: string,
  content: string,
  maxSymbols: number,
  symbolCount: { value: number },
): boolean {
  const ext = extensionOf(path);
  const isPython = ext === ".py";
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i] ?? "";
    const continueIndexing = isPython
      ? indexPythonLine(byName, path, lineNumber, line, maxSymbols, symbolCount)
      : indexTypeScriptLine(byName, path, lineNumber, line, maxSymbols, symbolCount);
    if (!continueIndexing) return false;
  }
  return true;
}

export async function buildSymbolIndex(
  paths: readonly string[],
  readFile: SymbolIndexReadFile,
  options?: {
    readonly maxSymbols?: number;
    readonly maxFileBytes?: number;
    readonly signal?: AbortSignal;
  },
): Promise<SymbolIndex> {
  const maxSymbols = options?.maxSymbols ?? LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_SYMBOLS;
  const maxFileBytes = options?.maxFileBytes ?? LOCAL_WORKSPACE_MAX_FILE_BYTES;
  const byName = new Map<string, SymbolIndexEntry[]>();
  const symbolCount = { value: 0 };

  for (const path of paths) {
    if (options?.signal?.aborted) break;
    if (!isIndexableSourcePath(path)) continue;
    const content = await readFile(path);
    if (content == null) continue;
    if (Buffer.byteLength(content, "utf8") > maxFileBytes) continue;
    if (!indexFileContent(byName, path, content, maxSymbols, symbolCount)) break;
  }

  return { byName, symbolCount: symbolCount.value };
}

export function querySymbolIndex(
  index: SymbolIndex | null | undefined,
  name: string,
  maxResults = LOCAL_WORKSPACE_SYMBOL_INDEX_MAX_RESULTS,
): readonly SymbolIndexEntry[] {
  if (!index || !name) return [];
  const matches = index.byName.get(name) ?? [];
  return matches.slice(0, maxResults);
}

export function symbolIndexStatus(index: SymbolIndex | null | undefined): SymbolIndexStatus {
  if (!index) return { available: false };
  return { available: true, symbolCount: index.symbolCount };
}

export function formatSymbolIndexStatusLine(status: SymbolIndexStatus): string {
  if (!status.available) return "Symbol index: unavailable.";
  return `Symbol index: built for ${status.symbolCount} symbols.`;
}
