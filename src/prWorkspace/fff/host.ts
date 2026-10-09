import { FileFinder, type GrepCursor } from "@ff-labs/fff-node";
import * as v from "valibot";

// Child-process entry for the fff search engine. fff runs synchronous FFI on
// its caller's thread, and a SIGBUS or Rust panic ends the process, so it is
// never loaded into the worker itself. Node runs this file without a build
// step in development, so it imports packages only, never relative modules.

const requestSchema = v.variant("op", [
  v.object({
    id: v.number(),
    op: v.literal("open"),
    key: v.string(),
    root: v.string(),
    scanTimeoutMs: v.number(),
    maxFiles: v.number(),
    maxIndexes: v.number(),
  }),
  v.object({
    id: v.number(),
    op: v.literal("grep"),
    key: v.string(),
    patterns: v.array(v.string()),
    denied: v.array(v.string()),
    maxMatchesPerFile: v.number(),
    maxMatches: v.number(),
    maxFileBytes: v.number(),
    pageSize: v.number(),
    timeBudgetMs: v.number(),
  }),
  v.object({
    id: v.number(),
    op: v.literal("files"),
    key: v.string(),
    query: v.string(),
    denied: v.array(v.string()),
    maxResults: v.number(),
  }),
  v.object({ id: v.number(), op: v.literal("close"), key: v.string() }),
]);

type HostRequest = v.InferOutput<typeof requestSchema>;

export type FffIndexedFile = { readonly path: string; readonly size: number };
export type FffOpenResult =
  | { readonly status: "ready"; readonly files: readonly FffIndexedFile[] }
  | { readonly status: "too_large"; readonly totalFiles: number };
export type FffGrepHit = { readonly path: string; readonly line: number };
export type FffGrepResult = {
  readonly hits: readonly FffGrepHit[];
  readonly capped: boolean;
};
export type FffFilesResult = { readonly paths: readonly string[] };
export type FffHostResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

const finders = new Map<string, FileFinder>();

function touch(key: string, finder: FileFinder): void {
  finders.delete(key);
  finders.set(key, finder);
}

function closeIndex(key: string): void {
  finders.get(key)?.destroy();
  finders.delete(key);
}

function listIndexedFiles(finder: FileFinder, totalFiles: number): FffIndexedFile[] {
  const listed = finder.fileSearch("", { pageSize: Math.max(totalFiles, 1) });
  if (!listed.ok) throw new Error(listed.error);
  return listed.value.items.map((item) => ({ path: item.relativePath, size: item.size }));
}

async function open(request: Extract<HostRequest, { op: "open" }>): Promise<FffOpenResult> {
  closeIndex(request.key);
  while (finders.size >= request.maxIndexes) {
    const oldest = finders.keys().next();
    if (oldest.done) break;
    closeIndex(oldest.value);
  }
  const created = FileFinder.create({
    basePath: request.root,
    disableWatch: true,
    aiMode: false,
    followSymlinks: false,
    logLevel: "error",
  });
  if (!created.ok) throw new Error(created.error);
  const finder = created.value;
  try {
    const scanned = await finder.waitForScan(request.scanTimeoutMs);
    if (!scanned.ok) throw new Error(scanned.error);
    if (!scanned.value) throw new Error("scan_timeout");
    const probe = finder.fileSearch("", { pageSize: 1 });
    if (!probe.ok) throw new Error(probe.error);
    const totalFiles = probe.value.totalFiles;
    if (totalFiles > request.maxFiles) {
      finder.destroy();
      return { status: "too_large", totalFiles };
    }
    const files = listIndexedFiles(finder, totalFiles);
    finders.set(request.key, finder);
    return { status: "ready", files };
  } catch (error) {
    finder.destroy();
    throw error;
  }
}

function grep(request: Extract<HostRequest, { op: "grep" }>): FffGrepResult {
  const finder = finders.get(request.key);
  if (finder == null) throw new Error("index_not_open");
  touch(request.key, finder);
  const denied = new Set(request.denied);
  const deadline = Date.now() + request.timeBudgetMs;
  const hits: FffGrepHit[] = [];
  let cursor: GrepCursor | null = null;
  for (;;) {
    const page = finder.multiGrep({
      patterns: request.patterns,
      constraints: "",
      smartCase: false,
      maxFileSize: request.maxFileBytes,
      maxMatchesPerFile: request.maxMatchesPerFile,
      pageSize: request.pageSize,
      cursor,
    });
    if (!page.ok) throw new Error(page.error);
    for (const item of page.value.items) {
      if (denied.has(item.relativePath)) continue;
      hits.push({ path: item.relativePath, line: item.lineNumber });
      if (hits.length >= request.maxMatches) return { hits, capped: true };
    }
    cursor = page.value.nextCursor;
    if (cursor == null) return { hits, capped: false };
    if (Date.now() > deadline) throw new Error("time_budget_exceeded");
  }
}

function findFiles(request: Extract<HostRequest, { op: "files" }>): FffFilesResult {
  const finder = finders.get(request.key);
  if (finder == null) throw new Error("index_not_open");
  touch(request.key, finder);
  const denied = new Set(request.denied);
  const found = finder.fileSearch(request.query, {
    pageSize: request.maxResults + denied.size + 1,
  });
  if (!found.ok) throw new Error(found.error);
  return {
    paths: found.value.items
      .map((item) => item.relativePath)
      .filter((path) => !denied.has(path))
      .slice(0, request.maxResults + 1),
  };
}

async function handle(request: HostRequest): Promise<unknown> {
  if (request.op === "open") return open(request);
  if (request.op === "grep") return grep(request);
  if (request.op === "files") return findFiles(request);
  closeIndex(request.key);
  return null;
}

function reply(response: FffHostResponse): void {
  process.send?.(response);
}

process.on("message", (message: unknown) => {
  const parsed = v.safeParse(requestSchema, message);
  if (!parsed.success) {
    const id =
      typeof message === "object" && message !== null && "id" in message ? message.id : null;
    if (typeof id === "number") reply({ id, ok: false, error: "invalid_request" });
    return;
  }
  const request = parsed.output;
  handle(request).then(
    (value) => reply({ id: request.id, ok: true, value }),
    (error: unknown) =>
      reply({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "fff_error",
      }),
  );
});

process.on("disconnect", () => {
  for (const key of finders.keys()) closeIndex(key);
  process.exit(0);
});
