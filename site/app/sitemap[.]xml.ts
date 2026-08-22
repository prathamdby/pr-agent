import { createFileRoute } from "@tanstack/react-router";
import { renderSitemapXml } from "@/lib/discovery";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(renderSitemapXml(new Date().toISOString()), {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
          },
        }),
    },
  },
});
