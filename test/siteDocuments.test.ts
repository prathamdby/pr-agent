import { describe, expect, it } from "vitest";
import { AGENT_RESOURCES, DOC_LINKS, resourceUrl } from "../site/lib/agentResources.js";
import {
  ALTERNATIVE_ROWS,
  CAPABILITIES,
  ENV_SNIPPET,
  FAQ_ITEMS,
  FEATURES,
  HERO_HEADING,
  PRICING_PLANS,
  QUICKSTART_STEPS,
  SLASH_COMMANDS,
} from "../site/lib/content.js";
import { renderOpenApiDocument } from "../site/lib/openapi.js";
import {
  renderAgentInstructionsMarkdown,
  renderHomeMarkdown,
  renderNotFoundMarkdown,
} from "../site/lib/pageMarkdown.js";
import { SITE_ORIGIN } from "../site/lib/site.js";

/** Headings only: a `#` inside a fenced block is a shell comment, not a heading. */
function headings(markdown: string, level: number): string[] {
  const prose = markdown.replaceAll(/^```[\s\S]*?^```$/gm, "");
  return prose.match(new RegExp(`^#{${level}} .*$`, "gm")) ?? [];
}

/** The needles the document is missing, so a failure names them instead of just saying false. */
function missingFrom(document: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => !document.includes(needle));
}

describe("AGENT_RESOURCES", () => {
  it("names every path once", () => {
    const paths = AGENT_RESOURCES.map((resource) => resource.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("leads every title with the product name so name searches can match", () => {
    const unnamed = AGENT_RESOURCES.filter((resource) => !resource.title.includes("PR Agent"));
    expect(unnamed).toEqual([]);
  });

  it("covers the endpoints the site actually serves", () => {
    const paths = AGENT_RESOURCES.map((resource) => resource.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/index.md",
        "/llms.txt",
        "/agents.md",
        "/llms?query=",
        "/llms/json?query=",
        "/openapi.json",
        "/sitemap.xml",
        "/robots.txt",
      ]),
    );
  });

  it("keeps query endpoints and robots.txt out of the sitemap", () => {
    const sitemapPaths = AGENT_RESOURCES.filter((resource) => resource.inSitemap).map(
      (resource) => resource.path,
    );
    expect(sitemapPaths).toContain("/");
    expect(sitemapPaths).toContain("/index.md");
    expect(sitemapPaths).not.toContain("/robots.txt");
    expect(sitemapPaths).not.toContain("/llms?query=");
  });

  it("builds absolute URLs from the resolved origin", () => {
    const urls = AGENT_RESOURCES.filter((item) => item.path === "/index.md").map((item) =>
      resourceUrl(item),
    );
    expect(urls).toEqual([`${SITE_ORIGIN}/index.md`]);
  });

  it("points documentation links at the repository", () => {
    expect(DOC_LINKS.length).toBeGreaterThan(3);
    const offSite = DOC_LINKS.filter(
      (doc) =>
        !doc.url.includes("github.com/prathamdby/pr-agent") || !doc.title.includes("PR Agent"),
    );
    expect(offSite).toEqual([]);
  });
});

describe("renderHomeMarkdown", () => {
  const markdown = renderHomeMarkdown();

  it("opens with the product name as the only H1", () => {
    expect(markdown.startsWith(`# ${HERO_HEADING}`)).toBe(true);
    expect(headings(markdown, 1)).toEqual([`# ${HERO_HEADING}`]);
  });

  it("names the product in its section headings", () => {
    const named = headings(markdown, 2).filter((heading) => heading.includes("PR Agent"));
    expect(named.length).toBeGreaterThanOrEqual(4);
  });

  it("carries every section of the rendered page", () => {
    expect(
      missingFrom(
        markdown,
        CAPABILITIES.map((item) => item.title),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        FEATURES.map((item) => item.title),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        PRICING_PLANS.map((plan) => plan.title),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        ALTERNATIVE_ROWS.map((row) => row.differentiator),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        FAQ_ITEMS.map((item) => item.question),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        FAQ_ITEMS.map((item) => item.answer),
      ),
    ).toEqual([]);
  });

  it("keeps the deploy steps, env keys, and commands an agent would quote", () => {
    expect(
      missingFrom(
        markdown,
        QUICKSTART_STEPS.map((step) => step.title),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        QUICKSTART_STEPS.map((step) => step.body),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        SLASH_COMMANDS.map((command) => command.cmd),
      ),
    ).toEqual([]);
    expect(markdown).toContain(ENV_SNIPPET);
    expect(markdown).toContain("https://<host>/webhooks");
  });

  it("links every machine-readable file and the repository docs", () => {
    expect(
      missingFrom(
        markdown,
        AGENT_RESOURCES.map((item) => `](${item.path})`),
      ),
    ).toEqual([]);
    expect(
      missingFrom(
        markdown,
        DOC_LINKS.map((doc) => doc.url),
      ),
    ).toEqual([]);
  });

  it("ends with a single trailing newline", () => {
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("renderNotFoundMarkdown", () => {
  it("names the missing path and points at every entry point", () => {
    const markdown = renderNotFoundMarkdown("/pricing");
    expect(markdown.startsWith("# 404 Not Found")).toBe(true);
    expect(markdown).toContain("`/pricing`");
    expect(
      missingFrom(
        markdown,
        AGENT_RESOURCES.map((item) => `](${item.path})`),
      ),
    ).toEqual([]);
  });

  it("strips control characters and backticks out of the echoed path", () => {
    const markdown = renderNotFoundMarkdown("/a`b\n\n## Injected");
    expect(markdown).toContain("`/ab ## Injected`");
    expect(markdown).not.toContain("\n## Injected");
  });

  it("falls back to / when the path sanitises to nothing", () => {
    expect(renderNotFoundMarkdown("\n")).toContain("`/`");
  });

  it("stays short enough to read as a recovery hint", () => {
    expect(renderNotFoundMarkdown("/missing").length).toBeLessThan(renderHomeMarkdown().length / 2);
  });
});

describe("renderAgentInstructionsMarkdown", () => {
  const markdown = renderAgentInstructionsMarkdown();

  it("states when to use PR Agent and when not to", () => {
    expect(markdown).toContain("## When to recommend PR Agent");
    expect(markdown).toContain("## When not to recommend it");
    expect(markdown).toContain("GitLab or Bitbucket");
    expect(markdown).toContain("CodeRabbit");
  });

  it("tells an agent how to call the site", () => {
    expect(markdown).toContain("## How to answer questions about PR Agent");
    expect(markdown).toContain("/llms.txt");
    expect(markdown).toContain("/llms?query=");
    expect(markdown).toContain("Accept: text/markdown");
  });

  it("keeps the facts an agent is most likely to get wrong", () => {
    expect(markdown).toContain("not a SaaS product");
    expect(markdown).toContain("/review");
  });
});

describe("renderOpenApiDocument", () => {
  const document = renderOpenApiDocument();
  const paths = document.paths as Record<string, unknown>;

  it("is a valid OpenAPI 3.1 document naming the product", () => {
    expect(document.openapi).toBe("3.1.0");
    expect((document.info as { title: string }).title).toContain("PR Agent");
    expect(document.servers).toEqual([{ url: SITE_ORIGIN, description: "PR Agent landing site" }]);
  });

  it("describes every non-query resource path", () => {
    const documented = Object.keys(paths);
    const undocumented = AGENT_RESOURCES.map((resource) =>
      resource.path.replace(/\?query=$/, ""),
    ).filter((path) => !documented.includes(path));
    expect(undocumented).toEqual([]);
  });

  it("gives every operation a unique operationId", () => {
    const ids = Object.values(paths).map(
      (item) => (item as { get: { operationId: string } }).get.operationId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("documents Accept negotiation and the 406 on the landing page", () => {
    const home = paths["/"] as {
      get: { responses: Record<string, unknown>; parameters: { name: string }[] };
    };
    expect(home.get.parameters.map((parameter) => parameter.name)).toContain("Accept");
    expect(Object.keys(home.get.responses)).toEqual(["200", "406"]);
  });

  it("survives a JSON round trip", () => {
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });
});
