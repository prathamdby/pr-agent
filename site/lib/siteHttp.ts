import { negotiateType } from "./accept.js";
import { negotiateProgrammingLanguage } from "./acceptLanguage.js";
import {
  AI_CATALOG,
  API_CATALOG,
  LANDING_PAGE_MARKDOWN,
  LLMS_TXT_PROFILE,
} from "./agentResources.js";
import { FETCH_MARKDOWN_LANGUAGES } from "./content.js";
import {
  applyRevisionHeaders,
  conditionalResponse,
  lastmodForSitemapPath,
  revisionFor,
  sitemapRevision,
  type ConditionalHeaders,
} from "./contentRevision.js";
import { renderSitemapXml } from "./discovery.js";
import { renderLlmsTxt } from "./llmsKnowledge.js";
import { renderOpenApiDocument } from "./openapi.js";
import { SITE_ORIGIN } from "./site.js";
import {
  renderAgentInstructionsMarkdown,
  renderHomeMarkdown,
  renderNotFoundMarkdown,
} from "./pageMarkdown.js";

const HTML_TYPE = "text/html";
const MARKDOWN_TYPE = "text/markdown";

const PAGE_TYPES = [HTML_TYPE, MARKDOWN_TYPE] as const;

const RECOVERY_TYPES = [MARKDOWN_TYPE, HTML_TYPE] as const;

const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=600, stale-while-revalidate=86400";
export const DOCUMENT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";
const ERROR_CACHE_CONTROL = "no-store";

const MARKDOWN_CONTENT_TYPE = `${MARKDOWN_TYPE}; charset=utf-8`;

const DISCOVERY_LINK = `<${API_CATALOG.path}>; rel="api-catalog"; type="${API_CATALOG.mediaType}", <${AI_CATALOG.path}>; rel="ai-catalog"; type="${AI_CATALOG.mediaType}"`;
const HTML_LINK = `<${LANDING_PAGE_MARKDOWN.path}>; rel="alternate"; type="${LANDING_PAGE_MARKDOWN.mediaType}", <${LLMS_TXT_PROFILE.path}>; rel="describedby", ${DISCOVERY_LINK}`;
const MARKDOWN_LINK = `<${LLMS_TXT_PROFILE.path}>; rel="describedby", ${DISCOVERY_LINK}`;

export function varyOn(headers: Headers, field: string): void {
  const existing = headers.get("Vary");
  if (existing === null || existing.trim() === "") {
    headers.set("Vary", field);
    return;
  }
  const listed = existing.split(",").map((token) => token.trim().toLowerCase());
  if (listed.includes(field.toLowerCase()) || listed.includes("*")) {
    return;
  }
  headers.set("Vary", `${existing}, ${field}`);
}

export function varyOnAccept(headers: Headers): void {
  varyOn(headers, "Accept");
}

function markdownResponse(body: string, init: { status: number; cacheControl: string }): Response {
  return new Response(body, {
    status: init.status,
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      "Cache-Control": init.cacheControl,
      "X-Content-Type-Options": "nosniff",
      Link: MARKDOWN_LINK,
    },
  });
}

export function notAcceptableResponse(produces: readonly string[]): Response {
  return new Response(`Not Acceptable\n\nAvailable: ${produces.join(", ")}\n`, {
    status: 406,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": ERROR_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
      Vary: "Accept",
    },
  });
}

const NO_VALIDATORS: ConditionalHeaders = { ifNoneMatch: null, ifModifiedSince: null };

function homeMarkdown(
  acceptLanguage: string | null,
  vary: readonly string[],
  conditional: ConditionalHeaders,
): Response {
  const language = negotiateProgrammingLanguage(acceptLanguage, FETCH_MARKDOWN_LANGUAGES);
  const varyHeader = vary.join(", ");
  const cached = conditionalResponse(conditional, revisionFor("landing"), {
    variant: language,
    honorModifiedSince: false,
    cacheControl: PAGE_CACHE_CONTROL,
    vary: varyHeader,
    extra: (headers) => {
      headers.set("Link", MARKDOWN_LINK);
    },
  });
  if (cached !== null) {
    return cached;
  }
  const response = markdownResponse(renderHomeMarkdown(language), {
    status: 200,
    cacheControl: PAGE_CACHE_CONTROL,
  });
  for (const field of vary) {
    varyOn(response.headers, field);
  }
  applyRevisionHeaders(response.headers, revisionFor("landing"), language);
  return response;
}

export function homeMarkdownResponse(
  acceptLanguage: string | null,
  conditional: ConditionalHeaders = NO_VALIDATORS,
): Response {
  return homeMarkdown(acceptLanguage, ["Accept", "Accept-Language"], conditional);
}

export function homeMarkdownDocumentResponse(
  acceptLanguage: string | null,
  conditional: ConditionalHeaders = NO_VALIDATORS,
): Response {
  return homeMarkdown(acceptLanguage, ["Accept-Language"], conditional);
}

export function agentInstructionsResponse(
  conditional: ConditionalHeaders = NO_VALIDATORS,
): Response {
  const revision = revisionFor("agents");
  const cached = conditionalResponse(conditional, revision, {
    honorModifiedSince: true,
    cacheControl: DOCUMENT_CACHE_CONTROL,
    extra: (headers) => {
      headers.set("Link", MARKDOWN_LINK);
      headers.set("X-Content-Type-Options", "nosniff");
    },
  });
  if (cached !== null) {
    return cached;
  }
  const response = markdownResponse(renderAgentInstructionsMarkdown(), {
    status: 200,
    cacheControl: DOCUMENT_CACHE_CONTROL,
  });
  applyRevisionHeaders(response.headers, revision);
  return response;
}

export function llmsProfileResponse(conditional: ConditionalHeaders = NO_VALIDATORS): Response {
  const revision = revisionFor("llms");
  const cached = conditionalResponse(conditional, revision, {
    honorModifiedSince: true,
    cacheControl: DOCUMENT_CACHE_CONTROL,
    extra: (headers) => {
      headers.set("X-Content-Type-Options", "nosniff");
    },
  });
  if (cached !== null) {
    return cached;
  }
  const response = new Response(renderLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": DOCUMENT_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
  applyRevisionHeaders(response.headers, revision);
  return response;
}

export function openApiResponse(conditional: ConditionalHeaders = NO_VALIDATORS): Response {
  const revision = revisionFor("openapi");
  const cached = conditionalResponse(conditional, revision, {
    honorModifiedSince: true,
    cacheControl: DOCUMENT_CACHE_CONTROL,
    extra: (headers) => {
      headers.set("X-Content-Type-Options", "nosniff");
    },
  });
  if (cached !== null) {
    return cached;
  }
  const headers = new Headers({
    "Cache-Control": DOCUMENT_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
  });
  applyRevisionHeaders(headers, revision);
  return Response.json(renderOpenApiDocument(), { headers });
}

export function sitemapResponse(
  conditional: ConditionalHeaders = NO_VALIDATORS,
  origin: string = SITE_ORIGIN,
): Response {
  const revision = sitemapRevision();
  const cached = conditionalResponse(conditional, revision, { honorModifiedSince: true });
  if (cached !== null) {
    cached.headers.set("Content-Type", "application/xml; charset=utf-8");
    varyOn(cached.headers, "Host");
    return cached;
  }
  const response = new Response(renderSitemapXml(lastmodForSitemapPath, origin), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
  applyRevisionHeaders(response.headers, revision);
  varyOn(response.headers, "Host");
  return response;
}

export function negotiateHomeRequest(
  accept: string | null,
  acceptLanguage: string | null,
  conditional: ConditionalHeaders = NO_VALIDATORS,
): Response | null {
  const chosen = negotiateType(accept, PAGE_TYPES);
  if (chosen === null) {
    return notAcceptableResponse(PAGE_TYPES);
  }
  if (chosen === MARKDOWN_TYPE) {
    return homeMarkdownResponse(acceptLanguage, conditional);
  }
  return null;
}

export function landingHtmlConditional(
  ifNoneMatch: string | null,
  ifModifiedSince: string | null,
): Response | null {
  return conditionalResponse({ ifNoneMatch, ifModifiedSince }, revisionFor("landing"), {
    honorModifiedSince: true,
    cacheControl: PAGE_CACHE_CONTROL,
    vary: "Accept",
    extra: (headers) => {
      headers.set("Link", HTML_LINK);
    },
  });
}

export function conditionalHeaders(request: Request): ConditionalHeaders {
  return {
    ifNoneMatch: request.headers.get("If-None-Match"),
    ifModifiedSince: request.headers.get("If-Modified-Since"),
  };
}

function withHeaders(response: Response, apply: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers);
  apply(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function decorateHtmlResponse(response: Response): Response {
  return withHeaders(response, (headers) => {
    varyOnAccept(headers);
    headers.set("Link", HTML_LINK);
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", PAGE_CACHE_CONTROL);
    }
    if (response.status === 200) {
      applyRevisionHeaders(headers, revisionFor("landing"));
    }
  });
}

export function restateAcceptAsHtml(headers: Headers): void {
  const accept = headers.get("Accept");
  if (accept === null) {
    return;
  }
  const rendersHtml = accept
    .split(",")
    .some((part) => part.trimStart().startsWith(HTML_TYPE) || part.trimStart().startsWith("*/*"));
  if (rendersHtml) {
    return;
  }
  headers.set("Accept", HTML_TYPE);
}

export function notFoundResponse(
  pathname: string,
  accept: string | null,
  rendered: Response,
): Response {
  const chosen = negotiateType(accept, RECOVERY_TYPES);
  if (chosen === null) {
    return notAcceptableResponse(RECOVERY_TYPES);
  }
  if (chosen === MARKDOWN_TYPE) {
    const response = markdownResponse(renderNotFoundMarkdown(pathname), {
      status: 404,
      cacheControl: ERROR_CACHE_CONTROL,
    });
    varyOnAccept(response.headers);
    return response;
  }
  return withHeaders(rendered, (headers) => {
    varyOnAccept(headers);
    headers.set("Link", HTML_LINK);
    headers.set("Cache-Control", ERROR_CACHE_CONTROL);
  });
}
