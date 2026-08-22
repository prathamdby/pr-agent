import { createFileRoute } from "@tanstack/react-router";
import { renderRobotsTxt } from "@/lib/discovery";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(renderRobotsTxt(), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
