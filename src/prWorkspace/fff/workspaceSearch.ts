import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { logWarn } from "../../evlog.js";
import {
  LOCAL_WORKSPACE_FFF_GREP_PAGE_FILES,
  LOCAL_WORKSPACE_FFF_GREP_TIME_BUDGET_MS,
  LOCAL_WORKSPACE_FFF_MAX_COLLECTED_MATCHES,
  LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES,
  LOCAL_WORKSPACE_FFF_MAX_INDEXED_FILES,
  LOCAL_WORKSPACE_FFF_MAX_LIVE_INDEXES,
  LOCAL_WORKSPACE_FFF_SCAN_TIMEOUT_MS,
} from "../../settings/index.js";
import type { GitGrepWorkspaceParams, GitGrepWorkspaceResult } from "../repositoryReader.js";
import { closeFffIndex, findFffFiles, grepFffIndex, openFffIndex } from "./client.js";

type WorkspaceSearchMatch = GitGrepWorkspaceResult["matches"][number];

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
  /** Tracked paths fff reads; everything else in the checkout goes to git grep. */
  readonly searchable: ReadonlySet<string>;
};

// fff 0.11.0 skips these extensions without reading them (`is_binary_extension_str`
// in fff-core). git grep -I still inspects their content, so they stay on git grep.
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

/**
 * Case-insensitive path ranking for paths fff does not index, and for every
 * path when the host is unavailable: basename substring, then path substring,
 * then an in-order character match; shorter paths first within a tier.
 */
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

/**
 * Literal search over a pinned checkout. fff answers for the files it indexes;
 * git grep answers for tracked files fff hides (dotfiles, ignored directories,
 * `.ignore` entries, large or binary-named files) and for the whole call when
 * the fff host is unavailable. Results keep git grep's path order and line text.
 */
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
    } catch (error) {
      index = null;
      logWarn("workspace_search_fff_fallback", { stage: "open", reason: String(error) });
      return null;
    }
  }

  async function readMatchedLines(
    hits: readonly { readonly path: string; readonly line: number }[],
  ): Promise<WorkspaceSearchMatch[]> {
    const linesByPath = new Map<string, Promise<string[] | null>>();
    const matches: WorkspaceSearchMatch[] = [];
    for (const hit of hits) {
      let lines = linesByPath.get(hit.path);
      if (lines == null) {
        const fullPath = join(root, hit.path);
        // Pinned checkouts strip symlinks; a link that reappears is never read.
        lines = lstat(fullPath)
          .then(async (info) =>
            info.isFile() ? (await readFile(fullPath, "utf8")).split("\n") : null,
          )
          .catch(() => null);
        linesByPath.set(hit.path, lines);
      }
      const text = (await lines)?.[hit.line - 1];
      if (text != null) matches.push({ path: hit.path, line: hit.line, text });
    }
    return matches;
  }

  async function search(request: GitGrepWorkspaceParams): Promise<GitGrepWorkspaceResult> {
    // git grep reads a newline as several patterns; fff cannot take a NUL. Keep both on git.
    if (/[\n\0]/.test(request.query)) return gitGrep(request);
    index ??= openIndex();
    const state = await index;
    if (state == null) return gitGrep(request);

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
        // A file never needs more lines than the whole result to fill it in path order.
        maxMatchesPerFile: limit,
        maxMatches: LOCAL_WORKSPACE_FFF_MAX_COLLECTED_MATCHES,
        maxFileBytes: LOCAL_WORKSPACE_FFF_MAX_FILE_BYTES,
        pageSize: LOCAL_WORKSPACE_FFF_GREP_PAGE_FILES,
        timeBudgetMs: LOCAL_WORKSPACE_FFF_GREP_TIME_BUDGET_MS,
      });
    } catch (error) {
      index = null;
      logWarn("workspace_search_fff_fallback", { stage: "grep", reason: String(error) });
      return gitGrep(request);
    }

    const gitResult =
      remainder.length > 0
        ? await gitGrep({ ...request, paths: remainder })
        : { matches: [], truncated: false };
    const fffMatches = await readMatchedLines(fffResult.hits.toSorted(compare).slice(0, limit));
    const merged = [...fffMatches, ...gitResult.matches].toSorted(compare).slice(0, limit);

    const matches: WorkspaceSearchMatch[] = [];
    let outputBytes = 0;
    let byteCapped = false;
    for (const match of merged) {
      outputBytes += matchBytes(match);
      if (request.maxOutputBytes != null && outputBytes > request.maxOutputBytes) {
        byteCapped = true;
        break;
      }
      matches.push(match);
    }
    return {
      matches,
      truncated:
        fffResult.capped || gitResult.truncated || byteCapped || merged.length > request.maxResults,
    };
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
