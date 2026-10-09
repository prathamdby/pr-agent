import { createFileRoute } from "@tanstack/react-router";
import { renderRobotsTxt } from "@/lib/discovery";
import { requestOrigin } from "@/lib/site";
import { varyOn } from "@/lib/siteHttp";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const headers = new Headers({
          "Content-Type": "text/plain; charset=utf-8",
        });
        varyOn(headers, "Host");
        return new Response(renderRobotsTxt(requestOrigin(request)), { headers });
      },
    },
  },
});
