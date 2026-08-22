import { negotiateType } from "./accept.js";
import { LANDING_PAGE_MARKDOWN, LLMS_TXT_PROFILE } from "./agentResources.js";
import {
  renderAgentInstructionsMarkdown,
  renderHomeMarkdown,
  renderNotFoundMarkdown,
} from "./pageMarkdown.js";

const HTML_TYPE = "text/html";
const MARKDOWN_TYPE = "text/markdown";

/** Server preference for the landing page: HTML unless the client asks for markdown. */
const PAGE_TYPES = [HTML_TYPE, MARKDOWN_TYPE] as const;

/**
 * Server preference for the 404 recovery document: markdown first.
 *
 * A browser still lands on HTML because it asks for `text/html` explicitly, above the catch-all
 * it appends. Everything that hits a dead path with a bare catch-all, or no Accept at all, is
 * tooling, and tooling recovers faster from a link list than from a rendered page.
 */
const RECOVERY_TYPES = [MARKDOWN_TYPE, HTML_TYPE] as const;

/**
 * Vercel strips `s-maxage` and `stale-while-revalidate` before the response reaches the browser,
 * so clients keep revalidating while the CDN serves both negotiated variants from its edge.
 */
const PAGE_CACHE_CONTROL = "public, max-age=0, s-maxage=600, stale-while-revalidate=86400";
/** Fixed-format documents (`/agents.md`, `/openapi.json`): long edge cache, no negotiation. */
export const DOCUMENT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";
const ERROR_CACHE_CONTROL = "no-store";

const MARKDOWN_CONTENT_TYPE = `${MARKDOWN_TYPE}; charset=utf-8`;

/**
 * RFC 8288 links. `describedby` points at the llms.txt covering this path, per llmstxt.org.
 * Targets come from the resource registry so the headers cannot drift from the sitemap, the
 * OpenAPI description, or the markdown link lists.
 */
const HTML_LINK = `<${LANDING_PAGE_MARKDOWN.path}>; rel="alternate"; type="${LANDING_PAGE_MARKDOWN.mediaType}", <${LLMS_TXT_PROFILE.path}>; rel="describedby"`;
const MARKDOWN_LINK = `<${LLMS_TXT_PROFILE.path}>; rel="describedby"`;

/** Add Accept to Vary without dropping whatever the framework already varies on. */
export function varyOnAccept(headers: Headers): void {
  const existing = headers.get("Vary");
  if (existing === null || existing.trim() === "") {
    headers.set("Vary", "Accept");
    return;
  }
  const listed = existing.split(",").map((token) => token.trim().toLowerCase());
  if (listed.includes("accept") || listed.includes("*")) {
    return;
  }
  headers.set("Vary", `${existing}, Accept`);
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

/**
 * 406 for a client that refused every representation we have.
 *
 * RFC 9110 asks for a body listing what is available so the client can retry with a usable Accept.
 */
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

export function homeMarkdownResponse(): Response {
  const response = markdownResponse(renderHomeMarkdown(), {
    status: 200,
    cacheControl: PAGE_CACHE_CONTROL,
  });
  varyOnAccept(response.headers);
  return response;
}

/**
 * `/index.md`, the markdown sibling advertised by `rel="alternate"` and llms.txt.
 *
 * It serves markdown whatever the client asks for: crawlers that follow such links often send no
 * Accept header at all. Nothing is negotiated here, so nothing declares Vary.
 */
export function homeMarkdownDocumentResponse(): Response {
  return markdownResponse(renderHomeMarkdown(), {
    status: 200,
    cacheControl: PAGE_CACHE_CONTROL,
  });
}

/** `/agents.md`: when to reach for PR Agent, and how an agent should query this site. */
export function agentInstructionsResponse(): Response {
  return markdownResponse(renderAgentInstructionsMarkdown(), {
    status: 200,
    cacheControl: DOCUMENT_CACHE_CONTROL,
  });
}

/**
 * Answer a landing-page request before the router renders.
 *
 * Returns null when HTML won, which leaves the React page to render exactly as it always has.
 */
export function negotiateHomeRequest(accept: string | null): Response | null {
  const chosen = negotiateType(accept, PAGE_TYPES);
  if (chosen === null) {
    return notAcceptableResponse(PAGE_TYPES);
  }
  if (chosen === MARKDOWN_TYPE) {
    return homeMarkdownResponse();
  }
  return null;
}

/** Copy a response so headers can be added even when the original guards them. */
function withHeaders(response: Response, apply: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers);
  apply(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Declare the variant axis and advertise the markdown sibling on the rendered page. */
export function decorateHtmlResponse(response: Response): Response {
  return withHeaders(response, (headers) => {
    varyOnAccept(headers);
    headers.set("Link", HTML_LINK);
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", PAGE_CACHE_CONTROL);
    }
  });
}

/**
 * Restate the negotiated representation in the header the renderer reads.
 *
 * TanStack Start renders a document only when some part of Accept starts with `text/html` or the
 * catch-all, matched literally. Without this, a spec-legal `text/*` on the landing page and any
 * `Accept: text/markdown` on a path with no route both end in a 500 instead of a page or a 404.
 * Negotiation has already decided by the time this runs, and the fixed-format routes ignore Accept
 * entirely, so the header can safely state HTML for whatever the renderer is about to do.
 *
 * Callers must read the client's real Accept header before calling this.
 */
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

/**
 * Turn the framework's bare 404 into something an agent can recover from.
 *
 * `accept` is passed in rather than read off the request: the renderer needs an HTML-shaped Accept
 * header to produce a 404 at all, so by this point the request no longer carries what the client
 * actually sent.
 *
 * The status stays 404 in every branch. A 200 carrying an app shell is what makes an agent
 * believe every path on a site exists.
 */
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
