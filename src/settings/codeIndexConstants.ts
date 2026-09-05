/** Optional Postgres FTS code index (navigation hints only). */
export const CODE_INDEX_MODES = ["off", "fts"] as const;
type CodeIndexMode = (typeof CODE_INDEX_MODES)[number];

export const DEFAULT_CODE_INDEX_MODE: CodeIndexMode = "off";
export const DEFAULT_CODE_INDEX_WAIT_MS = 3_000;
/** Delete superseded or aged code_index_snapshots (cascades chunks). */
export const DEFAULT_CODE_INDEX_RETENTION_SECONDS = 2_592_000;
export const CODE_INDEX_BUILD_QUEUE = "code-index-build";
export const CODE_INDEX_CHUNKER_VERSION = "1";
export const CODE_INDEX_MAX_CHUNKS_PER_REPO = 100_000;
export const CODE_INDEX_MAX_RESULTS = 20;
export const CODE_INDEX_PREVIEW_MAX_CHARS = 500;
export const CODE_INDEX_BUILD_CONCURRENCY = 1;
