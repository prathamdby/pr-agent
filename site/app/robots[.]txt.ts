import { createFileRoute } from "@tanstack/react-router";
import { SITE_ORIGIN } from "@/lib/site";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(`User-agent: *\nAllow: /\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
