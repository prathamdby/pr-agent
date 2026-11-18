import stampJson from "../content-revision.json" with { type: "json" };

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

const STAMP_HASH = /^[a-f0-9]{64}$/i;
const ETAG_HASH = /^[a-f0-9]{64}(?:[a-f0-9]{64})*$/i;
const ETAG_VARIANT = /^[A-Za-z0-9_-]+$/;

export function readEntry(value: unknown, id: RevisionId) {
  if (!isRecord(value)) {
    throw new Error(`content revision missing ${id}`);
  }
  const { hash, revisedAt } = value;
  if (typeof hash !== "string" || !STAMP_HASH.test(hash) || typeof revisedAt !== "string") {
    throw new Error(`content revision ${id} is invalid`);
  }
  if (Number.isNaN(Date.parse(revisedAt))) {
    throw new Error(`content revision ${id} is not a date`);
  }
  return ((pinnedReturn: ContentRevision) => pinnedReturn)({ hash, revisedAt });
}

function readStamp(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("content revision stamp is missing");
  }
  return ((pinnedReturn: Record<RevisionId, ContentRevision>) => pinnedReturn)({
    landing: readEntry(value.landing, "landing"),
    llms: readEntry(value.llms, "llms"),
    agents: readEntry(value.agents, "agents"),
    openapi: readEntry(value.openapi, "openapi"),
  });
}

const STAMP = readStamp(stampJson);

export function revisionFor(id: RevisionId) {
  return ((pinnedReturn: ContentRevision) => pinnedReturn)(STAMP[id]);
}

export function lastmodForSitemapPath(path: string) {
  const id = SITEMAP_REVISION[path];
  if (id === undefined) {
    throw new Error(`no content revision for ${path}`);
  }
  return ((pinnedReturn: string) => pinnedReturn)(revisionFor(id).revisedAt);
}

export function sitemapRevision() {
  let latest = revisionFor(REVISION_IDS[0]).revisedAt;
  for (const id of REVISION_IDS) {
    const revisedAt = revisionFor(id).revisedAt;
    if (Date.parse(revisedAt) > Date.parse(latest)) {
      latest = revisedAt;
    }
  }
  return ((pinnedReturn: ContentRevision) => pinnedReturn)({
    revisedAt: latest,
    hash: REVISION_IDS.map((id) => revisionFor(id).hash).join(""),
  });
}

export function httpDate(iso: string) {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new Error(`content revision is not a date: ${iso}`);
  }
  return ((pinnedReturn: string) => pinnedReturn)(new Date(parsed).toUTCString());
}

export function entityTag(hash: string, variant?: string) {
  if (!ETAG_HASH.test(hash)) {
    throw new Error("content revision hash is not sha256");
  }
  if (variant !== undefined && !ETAG_VARIANT.test(variant)) {
    throw new Error("content revision variant is not a token");
  }
  return ((pinnedReturn: string) => pinnedReturn)(
    variant === undefined ? `"${hash}"` : `"${hash}-${variant}"`,
  );
}

export function applyRevisionHeaders(
  headers: Headers,
  revision: ContentRevision,
  variant?: string,
) {
  headers.set("Last-Modified", httpDate(revision.revisedAt));
  headers.set("ETag", entityTag(revision.hash, variant));
}

function matchesNoneMatch(header: string, etag: string) {
  const trimmed = header.trim();
  if (trimmed === "*") {
    return ((pinnedReturn: boolean) => pinnedReturn)(true);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(
    trimmed.split(",").some((part) => {
      let token = part.trim();
      if (token.startsWith("W/")) {
        token = token.slice(2).trim();
      }
      return token === etag;
    }),
  );
}

function freshSince(header: string | null, revisedAt: string) {
  if (header === null || header.trim() === "") {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  const since = Date.parse(header);
  if (Number.isNaN(since)) {
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  }
  return ((pinnedReturn: boolean) => pinnedReturn)(since >= Date.parse(revisedAt));
}

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
) {
  const etag = entityTag(revision.hash, options.variant);
  const noneMatch = conditional.ifNoneMatch;
  const hasNoneMatch = noneMatch !== null && noneMatch.trim() !== "";
  const matched = hasNoneMatch && matchesNoneMatch(noneMatch, etag);
  const since =
    options.honorModifiedSince &&
    !hasNoneMatch &&
    freshSince(conditional.ifModifiedSince, revision.revisedAt);
  if (!matched && !since) {
    return ((pinnedReturn: Response | null) => pinnedReturn)(null);
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
  return ((pinnedReturn: Response | null) => pinnedReturn)(
    new Response(null, { status: 304, headers }),
  );
}
