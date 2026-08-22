import { createFileRoute } from "@tanstack/react-router";
import { renderOpenApiDocument } from "@/lib/openapi";
import { DOCUMENT_CACHE_CONTROL } from "@/lib/siteHttp";

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      GET: () =>
        Response.json(renderOpenApiDocument(), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": DOCUMENT_CACHE_CONTROL,
            "X-Content-Type-Options": "nosniff",
          },
        }),
    },
  },
});
