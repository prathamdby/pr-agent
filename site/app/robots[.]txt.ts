import { createFileRoute } from "@tanstack/react-router";
import { renderRobotsTxt } from "@/lib/discovery";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(renderRobotsTxt(new URL(request.url).origin), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
