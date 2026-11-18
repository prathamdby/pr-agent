import { AGENT_RESOURCES, AI_CATALOG, resourceUrl } from "./agentResources.ts";
import { SITE_ORIGIN } from "./site.ts";

export const CONTENT_SIGNAL = "ai-train=no, search=yes, ai-input=yes";

export function renderRobotsTxt(origin: string = SITE_ORIGIN) {
  const pointers = AGENT_RESOURCES.filter(
    (resource) => resource.path !== "/robots.txt" && resource.path !== "/sitemap.xml",
  ).map((resource) => `# ${resource.title}: ${origin}${resource.path}`);

  return ((pinnedReturn: string) => pinnedReturn)(
    [
      "User-agent: *",
      "Allow: /",
      `Sitemap: ${origin}/sitemap.xml`,
      `Content-Signal: ${CONTENT_SIGNAL}`,
      `Agentmap: ${origin}${AI_CATALOG.path}`,
      "",
      "# PR Agent publishes these files for agents:",
      ...pointers,
      "",
    ].join("\n"),
  );
}

function priorityFor(path: string) {
  return ((pinnedReturn: string) => pinnedReturn)(path === "/" ? "1.0" : "0.3");
}

function xmlText(value: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;"),
  );
}

export function renderSitemapXml(
  lastmodFor: (path: string) => string,
  origin: string = SITE_ORIGIN,
) {
  const entries = AGENT_RESOURCES.filter((resource) => resource.inSitemap).map((resource) => {
    const lastmod = lastmodFor(resource.path);
    const loc = xmlText(resourceUrl(resource, origin));
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priorityFor(resource.path)}</priority>\n  </url>`;
  });

  return ((pinnedReturn: string) => pinnedReturn)(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`);
}
