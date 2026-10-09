import { AGENT_RESOURCES, AI_CATALOG, resourceUrl } from "./agentResources.js";
import { SITE_ORIGIN } from "./site.js";

/**
 * Content Signals for this site: agents may read it, search crawlers may index it, and it is
 * not offered as training data. The values are the preference, not a claim that every crawler
 * honors them.
 */
export const CONTENT_SIGNAL = "ai-train=no, search=yes, ai-input=yes";

/**
 * robots.txt is often the first file an agent fetches, so the agent-facing files are named here.
 * The format has no directive for "here is my llms.txt", and comments are the only place a
 * non-standard pointer can go without confusing a strict parser. Content-Signal and Agentmap are
 * the exceptions: those drafts define real directives, so they sit with the crawl rules.
 *
 * `origin` follows the host that was requested. SITE_ORIGIN is the build host, which is wrong
 * for a preview deployment or a local scan.
 */
export function renderRobotsTxt(origin: string = SITE_ORIGIN): string {
  const pointers = AGENT_RESOURCES.filter(
    (resource) => resource.path !== "/robots.txt" && resource.path !== "/sitemap.xml",
  ).map((resource) => `# ${resource.title}: ${origin}${resource.path}`);

  return [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${origin}/sitemap.xml`,
    `Content-Signal: ${CONTENT_SIGNAL}`,
    `Agentmap: ${origin}${AI_CATALOG.path}`,
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

/**
 * Locations use the same host as robots.txt. SITE_ORIGIN is the build host, which is wrong
 * for a preview deployment or a local scan.
 */
export function renderSitemapXml(
  lastmodFor: (path: string) => string,
  origin: string = SITE_ORIGIN,
): string {
  const entries = AGENT_RESOURCES.filter((resource) => resource.inSitemap).map((resource) => {
    const lastmod = lastmodFor(resource.path);
    return `  <url>\n    <loc>${resourceUrl(resource, origin)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priorityFor(resource.path)}</priority>\n  </url>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}
