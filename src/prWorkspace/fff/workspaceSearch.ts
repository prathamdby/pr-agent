import { randomUUID } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../../errors/appError.ts";
import { logWarn } from "../../evlog.ts";
import {
  LOCAL_WORKSPACE_FFF_GREP_PAGE_FILES,
  LOCAL_WORKSPACE_FFF_GREP_TIME_BUDGET_MS,
  LOCAL_WORKSPACE_FFF_MAX_COLLECTED_MATCHES,
  LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_FFF_MAX_INDEXED_FILES,
  LOCAL_WORKSPACE_FFF_MAX_LIVE_INDEXES,
  LOCAL_WORKSPACE_FFF_SCAN_TIMEOUT_MS,
  LOCAL_WORKSPACE_SEARCH_MAX_MATCHES,
  LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
} from "../../settings/index.ts";
import type { GitGrepWorkspaceParams, GitGrepWorkspaceResult } from "../repositoryReader.ts";
import type { FffGrepHit } from "./host.ts";
import { closeFffIndex, findFffFiles, grepFffIndex, openFffIndex } from "./client.ts";

type WorkspaceSearchMatch = GitGrepWorkspaceResult["matches"][number];
type WorkspaceSearchCandidate = WorkspaceSearchMatch | FffGrepHit;

const MATCH_READ_CHUNK_BYTES = 64 * 1024;

type MatchReadBuffer = {
  readonly bytes: Buffer;
  offset: number;
  length: number;
};

function invalidSearchHit(): never {
  throw new AppError({
    domain: "pr_workspace",
    kind: "search_hit_invalid",
    message: "Workspace search hit could not be read",
  });
}

async function readMatchedLine(
  file: FileHandle,
  byteOffset: number,
  maxBytes: number,
  buffer: MatchReadBuffer,
): Promise<{ readonly text: string } | { readonly truncated: true }> {
  const parts: Buffer[] = [];
  let length = 0;
  let position = Math.max(byteOffset - 1, 0);
  let checkBoundary = byteOffset > 0;
  for (;;) {
    if (position < buffer.offset || position >= buffer.offset + buffer.length) {
      const { bytesRead } = await file.read(
        buffer.bytes,
        0,
        Math.min(buffer.bytes.length, maxBytes - length + 2),
        position,
      );
      buffer.offset = position;
      buffer.length = bytesRead;
      if (bytesRead === 0) {
        if (checkBoundary) invalidSearchHit();
        return { text: Buffer.concat(parts, length).toString("utf8") };
      }
    }
    let start = position - buffer.offset;
    if (checkBoundary) {
      if (buffer.bytes[start] !== 10) invalidSearchHit();
      start += 1;
      checkBoundary = false;
    }
    const rest = buffer.bytes.subarray(start, buffer.length);
    const newline = rest.indexOf(10);
    const part = newline < 0 ? rest : rest.subarray(0, newline);
    if (length + part.length > maxBytes) return { truncated: true };
    parts.push(Buffer.from(part));
    length += part.length;
    if (newline >= 0) return { text: Buffer.concat(parts, length).toString("utf8") };
    position = buffer.offset + buffer.length;
  }
}

export type WorkspaceFileSearchParams = {
  readonly query: string;
  readonly maxResults: number;
  readonly paths?: readonly string[];
};

export type WorkspaceFileSearchResult = {
  readonly paths: readonly string[];
  readonly truncated: boolean;
};

type FffIndexState = {
  readonly indexed: readonly string[];
  readonly indexedSet: ReadonlySet<string>;
  readonly searchable: ReadonlySet<string>;
};

const FFF_SKIPPED_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp ico webp tiff tif avif heic heif jxl jp2 j2k psd icns cur cr2 nef dng " +
    "tga rgbe hdr exr dds ktx ktx2 pvr astc ai webarchive mhtml mp4 avi mov wmv mkv mp3 wav " +
    "flac ogg m4a aac webm flv mpg mpeg wma opus pcm reapeaks zip tar gz bz2 xz 7z rar zst lz4 " +
    "lzma cab cpio jsonlz4 deb rpm apk dmg msi iso nupkg whl egg appimage flatpak crx pak exe " +
    "dll so dylib o a lib bin elf pdf doc docx xls xlsx ppt pptx db sqlite sqlite3 mdb " +
    "sqlite-wal sqlite-shm sqlite3-wal sqlite3-shm db-wal db-shm ldb ttf otf woff woff2 eot " +
    "class pyc pyo wasm dex jar war cmi cmt cmti cmx nib swiftdeps swiftdeps~ swiftdoc " +
    "swiftmodule swiftsourceinfo npy npz h5 hdf5 pt onnx safetensors tfrecord tflite gguf ggml " +
    "joblib glb blend blp dia bcmap pb parquet arrow suo"
  ).split(" "),
);

function fffSkipsExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 && FFF_SKIPPED_EXTENSIONS.has(name.slice(dot + 1));
}

export function rankPathsByQuery(query: string, paths: readonly string[]): string[] {
  const needle = query.toLowerCase();
  const scored: { path: string; tier: number }[] = [];
  for (const path of paths) {
    const haystack = path.toLowerCase();
    const basename = haystack.slice(haystack.lastIndexOf("/") + 1);
    let tier = -1;
    if (basename.includes(needle)) tier = 2;
    else if (haystack.includes(needle)) tier = 1;
    else {
      let at = 0;
      for (const char of haystack) if (char === needle[at]) at += 1;
      if (at === needle.length) tier = 0;
    }
    if (tier >= 0) scored.push({ path, tier });
  }
  scored.sort(
    (a, b) => b.tier - a.tier || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return scored.map((entry) => entry.path);
}

function matchBytes(match: WorkspaceSearchMatch): number {
  return (
    Buffer.byteLength(match.path) + String(match.line).length + Buffer.byteLength(match.text) + 3
  );
}

export function createFffWorkspaceSearch(params: {
  readonly root: string;
  readonly checkoutPaths: ReadonlySet<string>;
  readonly sortedCheckoutPaths: readonly string[];
  readonly gitGrep: (params: GitGrepWorkspaceParams) => Promise<GitGrepWorkspaceResult>;
}): {
  readonly search: (params: GitGrepWorkspaceParams) => Promise<GitGrepWorkspaceResult>;
  readonly findFiles: (params: WorkspaceFileSearchParams) => Promise<WorkspaceFileSearchResult>;
  readonly dispose: () => void;
} {
  const { root, checkoutPaths, sortedCheckoutPaths, gitGrep } = params;
  const key = randomUUID();
  let index: Promise<FffIndexState | null> | null = null;
  let opened = false;
  let disposed = false;
  let pathOrder: Map<string, number> | null = null;

  const order = (path: string) => {
    pathOrder ??= new Map(sortedCheckoutPaths.map((entry, position) => [entry, position]));
    return pathOrder.get(path) ?? Number.MAX_SAFE_INTEGER;
  };
  const compare = (
    a: { readonly path: string; readonly line: number },
    b: { readonly path: string; readonly line: number },
  ) => order(a.path) - order(b.path) || a.line - b.line;

  async function openIndex(): Promise<FffIndexState | null> {
    try {
      const result = await openFffIndex({
        key,
        root,
        scanTimeoutMs: LOCAL_WORKSPACE_FFF_SCAN_TIMEOUT_MS,
        maxFiles: LOCAL_WORKSPACE_FFF_MAX_INDEXED_FILES,
        maxIndexes: LOCAL_WORKSPACE_FFF_MAX_LIVE_INDEXES,
      });
      if (result.status === "too_large") {
        logWarn("workspace_search_fff_skipped", {
          reason: "too_many_files",
          totalFiles: result.totalFiles,
        });
        return null;
      }
      opened = true;
      if (disposed) {
        closeFffIndex(key);
        return null;
      }
      const searchable = new Set<string>();
      for (const file of result.files) {
        if (
          checkoutPaths.has(file.path) &&
          file.size <= LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES &&
          !fffSkipsExtension(file.path)
        )
          searchable.add(file.path);
      }
      const indexed = result.files.map((file) => file.path);
      return { indexed, indexedSet: new Set(indexed), searchable };
    } catch {
      index = null;
      logWarn("workspace_search_fff_fallback", { stage: "open", reason: "host_failure" });
      return null;
    }
  }

  async function readMatchedLines(
    candidates: readonly WorkspaceSearchCandidate[],
    request: GitGrepWorkspaceParams & { readonly maxOutputBytes: number },
  ): Promise<GitGrepWorkspaceResult> {
    const matches: WorkspaceSearchMatch[] = [];
    const buffer: MatchReadBuffer = {
      bytes: Buffer.allocUnsafe(MATCH_READ_CHUNK_BYTES),
      offset: 0,
      length: 0,
    };
    let outputBytes = 0;
    let file: FileHandle | undefined;
    let currentPath: string | undefined;
    let fileSize = 0;
    try {
      for (const candidate of candidates) {
        if (matches.length >= request.maxResults) return { matches, truncated: true };
        const remainingBytes =
          request.maxOutputBytes - outputBytes - matchBytes({ ...candidate, text: "" });
        if (remainingBytes < 0) return { matches, truncated: true };
        let text: string;
        if ("text" in candidate) {
          text = candidate.text;
        } else {
          if (candidate.path !== currentPath) {
            await file?.close();
            file = undefined;
            const fullPath = join(root, candidate.path);
            if (!(await lstat(fullPath)).isFile()) invalidSearchHit();
            file = await open(fullPath, "r");
            const info = await file.stat();
            if (!info.isFile() || info.size > LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES) {
              invalidSearchHit();
            }
            fileSize = info.size;
            currentPath = candidate.path;
            buffer.length = 0;
          }
          if (file == null || candidate.byteOffset >= fileSize) invalidSearchHit();
          const line = await readMatchedLine(file, candidate.byteOffset, remainingBytes, buffer);
          if ("truncated" in line) return { matches, truncated: true };
          text = line.text;
        }
        const match = { path: candidate.path, line: candidate.line, text };
        outputBytes += matchBytes(match);
        if (outputBytes > request.maxOutputBytes) return { matches, truncated: true };
        matches.push(match);
      }
      return { matches, truncated: false };
    } finally {
      await file?.close();
    }
  }

  async function searchGit(
    request: GitGrepWorkspaceParams & { readonly maxOutputBytes: number },
  ): Promise<GitGrepWorkspaceResult> {
    const result = await gitGrep(request);
    const bounded = await readMatchedLines(result.matches, request);
    return { matches: bounded.matches, truncated: result.truncated || bounded.truncated };
  }

  async function search(input: GitGrepWorkspaceParams): Promise<GitGrepWorkspaceResult> {
    const request = {
      ...input,
      maxResults: Math.min(input.maxResults, LOCAL_WORKSPACE_SEARCH_MAX_MATCHES),
      maxOutputBytes: Math.min(
        input.maxOutputBytes ?? LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
        LOCAL_WORKSPACE_SEARCH_MAX_TOTAL_BYTES,
      ),
    };
    if (/[\n\0]/.test(request.query)) return searchGit(request);
    index ??= openIndex();
    const state = await index;
    if (state == null) return searchGit(request);

    const allowed = request.paths ?? sortedCheckoutPaths;
    const allowedSet = request.paths ? new Set(request.paths) : checkoutPaths;
    const remainder = allowed.filter((path) => !state.searchable.has(path));
    const denied = state.indexed.filter(
      (path) => !(state.searchable.has(path) && allowedSet.has(path)),
    );
    const limit = request.maxResults + 1;

    let fffResult;
    try {
      fffResult = await grepFffIndex({
        key,
        patterns: [request.query],
        denied,
        maxMatchesPerFile: limit,
        maxMatches: LOCAL_WORKSPACE_FFF_MAX_COLLECTED_MATCHES,
        maxFileBytes: LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES,
        pageSize: LOCAL_WORKSPACE_FFF_GREP_PAGE_FILES,
        timeBudgetMs: LOCAL_WORKSPACE_FFF_GREP_TIME_BUDGET_MS,
      });
    } catch {
      index = null;
      logWarn("workspace_search_fff_fallback", { stage: "grep", reason: "host_failure" });
      return searchGit(request);
    }

    const gitResult =
      remainder.length > 0
        ? await gitGrep({ ...request, paths: remainder })
        : { matches: [], truncated: false };
    if (
      fffResult.hits.some((hit) => !state.searchable.has(hit.path) || !allowedSet.has(hit.path))
    ) {
      logWarn("workspace_search_fff_fallback", { stage: "read", reason: "invalid_hit_path" });
      return searchGit(request);
    }
    const candidates = [...fffResult.hits, ...gitResult.matches].toSorted(compare).slice(0, limit);
    try {
      const result = await readMatchedLines(candidates, request);
      return {
        matches: result.matches,
        truncated: fffResult.capped || gitResult.truncated || result.truncated,
      };
    } catch {
      logWarn("workspace_search_fff_fallback", { stage: "read", reason: "invalid_hit" });
      return searchGit(request);
    }
  }

  async function findFiles(request: WorkspaceFileSearchParams): Promise<WorkspaceFileSearchResult> {
    const allowed = request.paths ?? sortedCheckoutPaths;
    const allowedSet = request.paths ? new Set(request.paths) : checkoutPaths;
    index ??= openIndex();
    const state = await index;
    let ranked: readonly string[] = [];
    let remainder = allowed;
    if (state != null) {
      try {
        const found = await findFffFiles({
          key,
          query: request.query,
          denied: state.indexed.filter((path) => !allowedSet.has(path)),
          maxResults: request.maxResults,
        });
        ranked = found.paths;
        remainder = allowed.filter((path) => !state.indexedSet.has(path));
      } catch (error) {
        index = null;
        logWarn("workspace_search_fff_fallback", { stage: "files", reason: String(error) });
      }
    }
    const paths = [...new Set([...ranked, ...rankPathsByQuery(request.query, remainder)])];
    return {
      paths: paths.slice(0, request.maxResults),
      truncated: paths.length > request.maxResults,
    };
  }

  return {
    search,
    findFiles,
    dispose: () => {
      disposed = true;
      if (opened) closeFffIndex(key);
    },
  };
}
