import { describe, expect, it } from "vitest";
import { AGENT_RESOURCES, resourceUrl } from "../site/lib/agentResources.js";
import { renderRobotsTxt, renderSitemapXml } from "../site/lib/discovery.js";
import { SITE_ORIGIN } from "../site/lib/site.js";

describe("renderRobotsTxt", () => {
  const robots = renderRobotsTxt();

  it("keeps the crawl policy and sitemap directive first", () => {
    expect(robots.startsWith("User-agent: *\nAllow: /\n")).toBe(true);
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  it("names the agent files as comments so no parser mistakes them for directives", () => {
    const expected = AGENT_RESOURCES.filter(
      (resource) => resource.path !== "/robots.txt" && resource.path !== "/sitemap.xml",
    ).map((resource) => `# ${resource.title}: ${resourceUrl(resource)}`);
    expect(expected.filter((line) => !robots.includes(line))).toEqual([]);
  });

  it("emits no directive beyond User-agent, Allow, and Sitemap", () => {
    const directives = robots
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split(":")[0]);
    expect(new Set(directives)).toEqual(new Set(["User-agent", "Allow", "Sitemap"]));
  });
});

describe("renderSitemapXml", () => {
  const lastmod = "2026-01-01T00:00:00.000Z";
  const sitemap = renderSitemapXml(lastmod);

  it("lists every resource marked for the sitemap, and nothing else", () => {
    const expected = AGENT_RESOURCES.filter((resource) => resource.inSitemap);
    const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
    expect(locations).toEqual(expected.map((resource) => resourceUrl(resource)));
  });

  it("gives the landing page top priority", () => {
    expect(sitemap).toContain(
      `<loc>${SITE_ORIGIN}/</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>`,
    );
    expect(sitemap).toContain(`<loc>${SITE_ORIGIN}/index.md</loc>`);
  });

  it("stamps the caller's lastmod on every entry", () => {
    const stamps = [...sitemap.matchAll(/<lastmod>(.*?)<\/lastmod>/g)].map((match) => match[1]);
    expect(new Set(stamps)).toEqual(new Set([lastmod]));
  });

  it("declares the sitemap namespace and closes the urlset", () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset')).toBe(true);
    expect(sitemap).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(sitemap.trimEnd().endsWith("</urlset>")).toBe(true);
  });
});
