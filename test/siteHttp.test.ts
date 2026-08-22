import { describe, expect, it } from "vitest";
import { LANDING_PAGE_MARKDOWN, LLMS_TXT_PROFILE } from "../site/lib/agentResources.js";
import {
  DOCUMENT_CACHE_CONTROL,
  agentInstructionsResponse,
  decorateHtmlResponse,
  homeMarkdownDocumentResponse,
  homeMarkdownResponse,
  negotiateHomeRequest,
  notAcceptableResponse,
  notFoundResponse,
  restateAcceptAsHtml,
  varyOnAccept,
} from "../site/lib/siteHttp.js";

/** The alternate/describedby pair every HTML response advertises, built as the registry states it. */
const HTML_LINK = `<${LANDING_PAGE_MARKDOWN.path}>; rel="alternate"; type="${LANDING_PAGE_MARKDOWN.mediaType}", <${LLMS_TXT_PROFILE.path}>; rel="describedby"`;
const MARKDOWN_LINK = `<${LLMS_TXT_PROFILE.path}>; rel="describedby"`;

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

describe("negotiateHomeRequest", () => {
  it("hands markdown to a client that asks for it", async () => {
    const response = negotiateHomeRequest("text/markdown");
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response?.headers.get("Vary")).toBe("Accept");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response?.text()).toContain("# PR Agent");
  });

  it("defers to the React page for a browser, a bare catch-all, or no Accept at all", () => {
    expect(negotiateHomeRequest("text/html,*/*;q=0.8")).toBeNull();
    expect(negotiateHomeRequest("*/*")).toBeNull();
    expect(negotiateHomeRequest(null)).toBeNull();
  });

  it("refuses markdown when the client marked it q=0", () => {
    expect(negotiateHomeRequest("text/markdown;q=0, text/html")).toBeNull();
  });

  it("returns 406 with the available types when nothing matches", async () => {
    const response = negotiateHomeRequest("application/pdf");
    expect(response?.status).toBe(406);
    expect(response?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response?.headers.get("Vary")).toBe("Accept");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.text()).toBe("Not Acceptable\n\nAvailable: text/html, text/markdown\n");
  });

  it("caches both variants at the edge while browsers keep revalidating", () => {
    const markdown = homeMarkdownResponse();
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
  it("serves /index.md as markdown without claiming to negotiate", async () => {
    const response = homeMarkdownDocumentResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Vary")).toBeNull();
    expect(response.headers.get("Link")).toBe(MARKDOWN_LINK);
    expect(await response.text()).toBe(await homeMarkdownResponse().text());
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
