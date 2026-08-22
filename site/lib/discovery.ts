import { AGENT_RESOURCES, resourceUrl } from "./agentResources.js";
import { SITE_ORIGIN } from "./site.js";

/**
 * robots.txt is often the first file an agent fetches, so the agent-facing files are named here.
 * The format has no directive for "here is my llms.txt", and comments are the only place a
 * non-standard pointer can go without confusing a strict parser.
 */
export function renderRobotsTxt(): string {
  const pointers = AGENT_RESOURCES.filter(
    (resource) => resource.path !== "/robots.txt" && resource.path !== "/sitemap.xml",
  ).map((resource) => `# ${resource.title}: ${resourceUrl(resource)}`);

  return [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
    "# PR Agent publishes these files for agents:",
    ...pointers,
    "",
  ].join("\n");
}

/** The landing page changes most often, so it keeps top priority; the rest are reference files. */
function priorityFor(path: string): string {
  return path === "/" ? "1.0" : "0.3";
}

export function renderSitemapXml(lastmod: string): string {
  const entries = AGENT_RESOURCES.filter((resource) => resource.inSitemap).map(
    (resource) =>
      `  <url>\n    <loc>${resourceUrl(resource)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priorityFor(resource.path)}</priority>\n  </url>`,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}
