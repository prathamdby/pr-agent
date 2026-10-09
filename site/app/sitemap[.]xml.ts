import { createFileRoute } from "@tanstack/react-router";
import { requestOrigin } from "@/lib/site";
import { conditionalHeaders, sitemapResponse } from "@/lib/siteHttp";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: ({ request }) => sitemapResponse(conditionalHeaders(request), requestOrigin(request)),
    },
  },
});
