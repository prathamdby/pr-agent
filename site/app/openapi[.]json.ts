import { createFileRoute } from "@tanstack/react-router";
import { renderOpenApiDocument } from "@/lib/openapi";

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(renderOpenApiDocument(), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
            "X-Content-Type-Options": "nosniff",
          },
        }),
    },
  },
});
