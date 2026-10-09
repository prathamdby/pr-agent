import { createFileRoute } from "@tanstack/react-router";
import { conditionalHeaders, sitemapResponse } from "@/lib/siteHttp";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: ({ request }) =>
        sitemapResponse(conditionalHeaders(request), new URL(request.url).origin),
    },
  },
});
