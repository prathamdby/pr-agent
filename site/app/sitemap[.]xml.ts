import { createFileRoute } from "@tanstack/react-router";
import { SITE_ORIGIN } from "@/lib/site";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_ORIGIN}</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_ORIGIN}/llms.txt</loc>
    <changefreq>weekly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>
`,
          {
            headers: {
              "Content-Type": "application/xml; charset=utf-8",
            },
          },
        ),
    },
  },
});
