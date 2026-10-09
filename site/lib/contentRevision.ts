import stampJson from "../content-revision.json" with { type: "json" };

/**
 * Committed content revisions. The client graph imports this module for `dateModified`,
 * so it stays on the JSON import and never reads the filesystem.
 */
export const REVISION_IDS = ["landing", "llms", "agents", "openapi"] as const;

export type RevisionId = (typeof REVISION_IDS)[number];

export type ContentRevision = {
  readonly hash: string;
  readonly revisedAt: string;
};

export type ConditionalHeaders = {
  readonly ifNoneMatch: string | null;
  readonly ifModifiedSince: string | null;
};

const SITEMAP_REVISION: Record<string, RevisionId> = {
  "/": "landing",
  "/index.md": "landing",
  "/llms.txt": "llms",
  "/agents.md": "agents",
  "/openapi.json": "openapi",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readEntry(value: unknown, id: RevisionId): ContentRevision {
  if (!isRecord(value)) {
    throw new Error(`content revision missing ${id}`);
  }
  const { hash, revisedAt } = value;
  if (typeof hash !== "string" || hash === "" || typeof revisedAt !== "string") {
    throw new Error(`content revision ${id} is invalid`);
  }
  if (Number.isNaN(Date.parse(revisedAt))) {
    throw new Error(`content revision ${id} is not a date`);
  }
  return { hash, revisedAt };
}

function readStamp(value: unknown): Record<RevisionId, ContentRevision> {
  if (!isRecord(value)) {
    throw new Error("content revision stamp is missing");
  }
  return {
    landing: readEntry(value.landing, "landing"),
    llms: readEntry(value.llms, "llms"),
    agents: readEntry(value.agents, "agents"),
    openapi: readEntry(value.openapi, "openapi"),
  };
}

const STAMP = readStamp(stampJson);

export function revisionFor(id: RevisionId): ContentRevision {
  return STAMP[id];
}

/** ISO instant for one sitemap URL. Throws when a new sitemap path has no revision. */
export function lastmodForSitemapPath(path: string): string {
  const id = SITEMAP_REVISION[path];
  if (id === undefined) {
    throw new Error(`no content revision for ${path}`);
  }
  return revisionFor(id).revisedAt;
}

/** Sitemap validators move when any published document moves. */
export function sitemapRevision(): ContentRevision {
  let latest = revisionFor(REVISION_IDS[0]).revisedAt;
  for (const id of REVISION_IDS) {
    const revisedAt = revisionFor(id).revisedAt;
    if (Date.parse(revisedAt) > Date.parse(latest)) {
      latest = revisedAt;
    }
  }
  return {
    revisedAt: latest,
    hash: REVISION_IDS.map((id) => revisionFor(id).hash).join(""),
  };
}

/** RFC 9110 IMF-fixdate. Sitemap and JSON-LD keep the ISO form. */
export function httpDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new Error(`content revision is not a date: ${iso}`);
  }
  return new Date(parsed).toUTCString();
}

export function entityTag(hash: string, variant?: string): string {
  return variant === undefined ? `"${hash}"` : `"${hash}-${variant}"`;
}

export function applyRevisionHeaders(
  headers: Headers,
  revision: ContentRevision,
  variant?: string,
): void {
  headers.set("Last-Modified", httpDate(revision.revisedAt));
  headers.set("ETag", entityTag(revision.hash, variant));
}

function matchesNoneMatch(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "*") {
    return true;
  }
  return trimmed.split(",").some((part) => {
    let token = part.trim();
    if (token.startsWith("W/")) {
      token = token.slice(2).trim();
    }
    return token === etag;
  });
}

function freshSince(header: string | null, revisedAt: string): boolean {
  if (header === null || header.trim() === "") {
    return false;
  }
  const since = Date.parse(header);
  if (Number.isNaN(since)) {
    return false;
  }
  return since >= Date.parse(revisedAt);
}

/**
 * 304 when the caller's validators still match.
 *
 * `If-None-Match` wins over `If-Modified-Since` (RFC 9110). Markdown passes
 * `honorModifiedSince: false` because `Accept-Language` changes the example, and a
 * time check cannot name which language the client cached.
 */
export function conditionalResponse(
  conditional: ConditionalHeaders,
  revision: ContentRevision,
  options: {
    readonly variant?: string;
    readonly honorModifiedSince: boolean;
    readonly cacheControl?: string;
    readonly vary?: string;
    readonly extra?: (headers: Headers) => void;
  },
): Response | null {
  const etag = entityTag(revision.hash, options.variant);
  const noneMatch = conditional.ifNoneMatch;
  const hasNoneMatch = noneMatch !== null && noneMatch.trim() !== "";
  const matched = hasNoneMatch && matchesNoneMatch(noneMatch, etag);
  const since =
    options.honorModifiedSince &&
    !hasNoneMatch &&
    freshSince(conditional.ifModifiedSince, revision.revisedAt);
  if (!matched && !since) {
    return null;
  }
  const headers = new Headers();
  headers.set("ETag", etag);
  headers.set("Last-Modified", httpDate(revision.revisedAt));
  if (options.cacheControl !== undefined) {
    headers.set("Cache-Control", options.cacheControl);
  }
  if (options.vary !== undefined) {
    headers.set("Vary", options.vary);
  }
  options.extra?.(headers);
  return new Response(null, { status: 304, headers });
}
