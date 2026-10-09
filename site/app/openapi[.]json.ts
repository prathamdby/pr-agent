import { createFileRoute } from "@tanstack/react-router";
import { conditionalHeaders, openApiResponse } from "@/lib/siteHttp";

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      GET: ({ request }) => openApiResponse(conditionalHeaders(request)),
    },
  },
});
