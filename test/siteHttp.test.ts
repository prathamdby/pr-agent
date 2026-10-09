import { describe, expect, it } from "vitest";
import {
  AI_CATALOG,
  API_CATALOG,
  LANDING_PAGE_MARKDOWN,
  LLMS_TXT_PROFILE,
} from "../site/lib/agentResources.js";
import {
  conditionalResponse,
  revisionFor,
  type ConditionalHeaders,
} from "../site/lib/contentRevision.js";
import {
  DOCUMENT_CACHE_CONTROL,
  agentInstructionsResponse,
  decorateHtmlResponse,
  homeMarkdownDocumentResponse,
  homeMarkdownResponse,
  landingHtmlConditional,
  llmsProfileResponse,
  negotiateHomeRequest,
  notAcceptableResponse,
  notFoundResponse,
  openApiResponse,
  restateAcceptAsHtml,
  sitemapResponse,
  varyOn,
  varyOnAccept,
} from "../site/lib/siteHttp.js";

/** Alternate, describedby, and discovery links, built as the registry states them. */
const DISCOVERY_LINK = `<${API_CATALOG.path}>; rel="api-catalog"; type="${API_CATALOG.mediaType}", <${AI_CATALOG.path}>; rel="ai-catalog"; type="${AI_CATALOG.mediaType}"`;
const HTML_LINK = `<${LANDING_PAGE_MARKDOWN.path}>; rel="alternate"; type="${LANDING_PAGE_MARKDOWN.mediaType}", <${LLMS_TXT_PROFILE.path}>; rel="describedby", ${DISCOVERY_LINK}`;
const MARKDOWN_LINK = `<${LLMS_TXT_PROFILE.path}>; rel="describedby", ${DISCOVERY_LINK}`;

/** Stand-in for whatever the router rendered before the middleware saw it. */
function rendered(status: number): Response {
  return new Response('<!DOCTYPE html><html lang="en"><body>page</body></html>', {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

describe("varyOnAccept", () => {
  it("sets Vary when the response has none", () => {
    const headers = new Headers();
    varyOnAccept(headers);
    expect(headers.get("Vary")).toBe("Accept");
  });

  it("appends to an existing Vary without dropping it", () => {
    const headers = new Headers({ Vary: "Accept-Encoding" });
    varyOnAccept(headers);
    expect(headers.get("Vary")).toBe("Accept-Encoding, Accept");
  });

  it("does not repeat Accept, whatever its case", () => {
    const headers = new Headers({ Vary: "accept, Accept-Encoding" });
    varyOnAccept(headers);
    expect(headers.get("Vary")).toBe("accept, Accept-Encoding");
  });

  it("leaves a wildcard Vary alone", () => {
    const headers = new Headers({ Vary: "*" });
    varyOnAccept(headers);
    expect(headers.get("Vary")).toBe("*");
  });
});

describe("varyOn", () => {
  it("lists each field once, in the order it was declared", () => {
    const headers = new Headers();
    varyOn(headers, "Accept");
    varyOn(headers, "Accept-Language");
    varyOn(headers, "accept-language");
    expect(headers.get("Vary")).toBe("Accept, Accept-Language");
  });
});

describe("negotiateHomeRequest", () => {
  it("hands markdown to a client that asks for it", async () => {
    const response = negotiateHomeRequest("text/markdown", null);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response?.headers.get("Vary")).toBe("Accept, Accept-Language");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await response?.text();
    expect(body).toContain("# PR Agent");
    expect(body).toContain("```typescript\n");
  });

  it("renders the fetch example in the language named after the locale", async () => {
    const response = negotiateHomeRequest("text/markdown", "en-us, python");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Vary")).toBe("Accept, Accept-Language");
    const body = await response?.text();
    expect(body).toContain("```python\n");
    expect(body).not.toContain("```typescript\n");
  });

  it.each(["en", "en-US", "ts", "sh", "rust"])(
    "keeps the typescript example for Accept-Language %s",
    async (acceptLanguage) => {
      const body = await negotiateHomeRequest("text/markdown", acceptLanguage)?.text();
      expect(body).toContain("```typescript\n");
    },
  );

  it("defers to the React page for a browser, a bare catch-all, or no Accept at all", () => {
    expect(negotiateHomeRequest("text/html,*/*;q=0.8", null)).toBeNull();
    expect(negotiateHomeRequest("text/html,*/*;q=0.8", "python")).toBeNull();
    expect(negotiateHomeRequest("*/*", null)).toBeNull();
    expect(negotiateHomeRequest(null, null)).toBeNull();
  });

  it("refuses markdown when the client marked it q=0", () => {
    expect(negotiateHomeRequest("text/markdown;q=0, text/html", null)).toBeNull();
  });

  it("returns 406 with the available types when nothing matches", async () => {
    const response = negotiateHomeRequest("application/pdf", "python");
    expect(response?.status).toBe(406);
    expect(response?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response?.headers.get("Vary")).toBe("Accept");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.text()).toBe("Not Acceptable\n\nAvailable: text/html, text/markdown\n");
  });

  it("caches both variants at the edge while browsers keep revalidating", () => {
    const markdown = homeMarkdownResponse(null);
    expect(markdown.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=600, stale-while-revalidate=86400",
    );
  });
});

describe("decorateHtmlResponse", () => {
  it("declares the variant axis and advertises the markdown sibling", () => {
    const response = decorateHtmlResponse(rendered(200));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(response.headers.get("Link")).toBe(HTML_LINK);
  });

  it("keeps the body the router produced", async () => {
    expect(await decorateHtmlResponse(rendered(200)).text()).toContain("<body>page</body>");
  });

  it("does not overwrite a Cache-Control the route already set", () => {
    const response = decorateHtmlResponse(
      new Response("page", { headers: { "Cache-Control": "private, no-store" } }),
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("notFoundResponse", () => {
  it("keeps 404 and serves markdown to a client with no Accept constraint", async () => {
    const response = notFoundResponse("/missing", null, rendered(404));
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("# 404 Not Found");
    expect(body).toContain("/missing");
    expect(body).toContain("/llms.txt");
    expect(body).toContain("/sitemap.xml");
  });

  it("keeps 404 and the rendered page for a browser", async () => {
    const response = notFoundResponse(
      "/missing",
      "text/html,application/xhtml+xml,*/*;q=0.8",
      rendered(404),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(response.headers.get("Link")).toBe(HTML_LINK);
    expect(await response.text()).toContain("<body>page</body>");
  });

  it("merges Vary and forces no-store on a rendered 404 that already sets headers", async () => {
    const cached = new Response('<!DOCTYPE html><html lang="en"><body>page</body></html>', {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        Vary: "Accept-Encoding",
        "Cache-Control": "public, max-age=600",
      },
    });
    const response = notFoundResponse("/missing", "text/html", cached);
    expect(response.status).toBe(404);
    expect(response.headers.get("Vary")).toBe("Accept-Encoding, Accept");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Link")).toBe(HTML_LINK);
    expect(await response.text()).toContain("<body>page</body>");
  });

  it("serves markdown to an agent that asked for it, not the renderer's HTML", async () => {
    const response = notFoundResponse("/missing", "text/markdown", rendered(404));
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toContain("# 404 Not Found");
  });

  it("returns 406 when the client refuses both representations", async () => {
    const response = notFoundResponse("/missing", "application/pdf", rendered(404));
    expect(response.status).toBe(406);
    expect(await response.text()).toBe("Not Acceptable\n\nAvailable: text/markdown, text/html\n");
  });

  it("neutralises a path that tries to inject markdown structure", async () => {
    const body = await notFoundResponse(
      `/${encodeURIComponent("x\n\n## Injected heading")}`,
      null,
      rendered(404),
    ).text();
    expect(body).not.toContain("\n## Injected heading");
    expect(body).toContain("## Where to look next");
  });

  it("leaves a path percent-encoded rather than letting it close the code span", async () => {
    const body = await notFoundResponse(
      `/${encodeURIComponent("a`b")}`,
      null,
      rendered(404),
    ).text();
    expect(body).toContain("`/a%60b`");
    expect(body).not.toContain("`/a`b`");
  });
});

describe("fixed-format markdown documents", () => {
  it("serves /index.md as markdown, varying on the example language only", async () => {
    const response = homeMarkdownDocumentResponse(null);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept-Language");
    expect(response.headers.get("Link")).toBe(MARKDOWN_LINK);
    expect(await response.text()).toBe(await homeMarkdownResponse(null).text());
  });

  it("honours Accept-Language on /index.md", async () => {
    const body = await homeMarkdownDocumentResponse("go").text();
    expect(body).toContain("```go\n");
    expect(body).toBe(await homeMarkdownResponse("go").text());
  });

  it("serves /agents.md as a cacheable document without claiming to negotiate", async () => {
    const response = agentInstructionsResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe(DOCUMENT_CACHE_CONTROL);
    expect(response.headers.get("Vary")).toBeNull();
    expect(response.headers.get("Link")).toBe(MARKDOWN_LINK);
    const body = await response.text();
    expect(body).toContain("# PR Agent agent instructions");
    expect(body).toContain("## When to recommend PR Agent");
    expect(body).toContain("## When not to recommend it");
  });
});

describe("restateAcceptAsHtml", () => {
  it("rewrites a header the renderer would refuse", () => {
    const headers = new Headers({ Accept: "text/*" });
    restateAcceptAsHtml(headers);
    expect(headers.get("Accept")).toBe("text/html");
  });

  it("rewrites a markdown request so the renderer can still produce the 404", () => {
    const headers = new Headers({ Accept: "text/markdown" });
    restateAcceptAsHtml(headers);
    expect(headers.get("Accept")).toBe("text/html");
  });

  it("leaves a header the renderer already accepts", () => {
    for (const accept of ["text/html", "*/*", "text/html,application/xhtml+xml", "text/*, */*"]) {
      const headers = new Headers({ Accept: accept });
      restateAcceptAsHtml(headers);
      expect(headers.get("Accept")).toBe(accept);
    }
  });

  it("leaves a missing header alone, since the renderer defaults it to the catch-all", () => {
    const headers = new Headers();
    restateAcceptAsHtml(headers);
    expect(headers.get("Accept")).toBeNull();
  });
});

describe("notAcceptableResponse", () => {
  it("lists the representations in the order the caller produces them", async () => {
    expect(await notAcceptableResponse(["text/markdown"]).text()).toBe(
      "Not Acceptable\n\nAvailable: text/markdown\n",
    );
  });
});

async function expectFresh304(
  load: (conditional?: ConditionalHeaders) => Response,
  contentTypeOn304?: string,
): Promise<void> {
  const first = load();
  const etag = first.headers.get("ETag");
  const lastModified = first.headers.get("Last-Modified");
  expect(first.status).toBe(200);
  expect(etag).toMatch(/^"[0-9a-f]+"$/);
  expect(lastModified).toMatch(/GMT$/);

  const byTag = load({ ifNoneMatch: etag, ifModifiedSince: null });
  expect(byTag.status).toBe(304);
  expect(await byTag.text()).toBe("");
  expect(byTag.headers.get("ETag")).toBe(etag);
  expect(byTag.headers.get("Last-Modified")).toBe(lastModified);

  const byDate = load({ ifNoneMatch: null, ifModifiedSince: lastModified });
  expect(byDate.status).toBe(304);
  expect(await byDate.text()).toBe("");
  expect(byDate.headers.get("ETag")).toBe(etag);
  expect(byDate.headers.get("Last-Modified")).toBe(lastModified);

  if (contentTypeOn304 !== undefined) {
    expect(byTag.headers.get("Content-Type")).toBe(contentTypeOn304);
    expect(byDate.headers.get("Content-Type")).toBe(contentTypeOn304);
  }

  const bogus = load({ ifNoneMatch: null, ifModifiedSince: "not-a-date" });
  expect(bogus.status).toBe(200);
  expect(await bogus.text()).not.toBe("");
}

describe("content revision validators", () => {
  it("puts the landing date on the HTML page", () => {
    const response = decorateHtmlResponse(rendered(200));
    expect(response.headers.get("Last-Modified")).toMatch(/GMT$/);
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
  });

  it("returns 304 for a fresh HTML revalidation and 200 for a garbage date", async () => {
    const lastModified = decorateHtmlResponse(rendered(200)).headers.get("Last-Modified");
    const fresh = landingHtmlConditional(null, lastModified);
    expect(fresh?.status).toBe(304);
    expect(await fresh?.text()).toBe("");
    expect(fresh?.headers.get("Last-Modified")).toBe(lastModified);
    expect(landingHtmlConditional(null, "not-a-date")).toBeNull();
  });

  it("does not 304 markdown from If-Modified-Since, only from its language ETag", async () => {
    const python = negotiateHomeRequest("text/markdown", "python");
    const since = negotiateHomeRequest("text/markdown", "python", {
      ifNoneMatch: null,
      ifModifiedSince: python?.headers.get("Last-Modified") ?? null,
    });
    expect(since?.status).toBe(200);
    expect(await since?.text()).toContain("```python\n");

    const matched = negotiateHomeRequest("text/markdown", "python", {
      ifNoneMatch: python?.headers.get("ETag") ?? null,
      ifModifiedSince: null,
    });
    expect(matched?.status).toBe(304);
    expect(await matched?.text()).toBe("");

    const otherLanguage = negotiateHomeRequest("text/markdown", null, {
      ifNoneMatch: python?.headers.get("ETag") ?? null,
      ifModifiedSince: null,
    });
    expect(otherLanguage?.status).toBe(200);
    expect(await otherLanguage?.text()).toContain("```typescript\n");
  });

  it("304s on If-None-Match star, weak validators, and lists", async () => {
    const page = decorateHtmlResponse(rendered(200));
    const etag = page.headers.get("ETag");
    const lastModified = page.headers.get("Last-Modified");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const direct = conditionalResponse(
      { ifNoneMatch: "*", ifModifiedSince: null },
      revisionFor("landing"),
      { honorModifiedSince: true },
    );
    expect(direct?.status).toBe(304);
    expect(direct?.headers.get("ETag")).toBe(etag);
    expect(direct?.headers.get("Last-Modified")).toBe(lastModified);
    for (const ifNoneMatch of ["*", `W/${etag}`, `"other", W/${etag}`]) {
      const response = landingHtmlConditional(ifNoneMatch, "not-a-date");
      expect(response?.status).toBe(304);
      expect(await response?.text()).toBe("");
      expect(response?.headers.get("ETag")).toBe(etag);
      expect(response?.headers.get("Last-Modified")).toBe(lastModified);
    }
  });

  it("304s llms, openapi, and sitemap on ETag or date, and ignores a garbage date", async () => {
    await expectFresh304(llmsProfileResponse);
    await expectFresh304(openApiResponse);
    await expectFresh304(sitemapResponse, "application/xml; charset=utf-8");
  });

  it("304s /agents.md when the client already has that date", async () => {
    const first = agentInstructionsResponse();
    const second = agentInstructionsResponse({
      ifNoneMatch: null,
      ifModifiedSince: first.headers.get("Last-Modified"),
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("keeps one sitemap lastmod across reads and aligns the homepage with its HTTP date", async () => {
    const first = sitemapResponse();
    const second = sitemapResponse();
    const xml = await first.text();
    expect(xml).toBe(await second.text());
    expect(first.headers.get("Last-Modified")).toBe(second.headers.get("Last-Modified"));
    const homepage = xml.match(/<loc>[^<]*\/<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/);
    const landingModified = decorateHtmlResponse(rendered(200)).headers.get("Last-Modified");
    expect(new Date(homepage?.[1] ?? "").toUTCString()).toBe(landingModified);
    const preview = sitemapResponse(
      { ifNoneMatch: null, ifModifiedSince: null },
      "https://preview.example",
    );
    expect(await preview.text()).toContain("<loc>https://preview.example/</loc>");
  });

  it("serves /llms.txt with the committed revision rather than a clock", () => {
    const response = llmsProfileResponse();
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Last-Modified")).toMatch(/GMT$/);
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
  });
});
