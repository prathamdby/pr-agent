import { createFileRoute } from "@tanstack/react-router";
import { apiCatalogResponse, originOf } from "@/lib/agentDiscovery";

export const Route = createFileRoute("/.well-known/api-catalog")({
  server: {
    handlers: {
      GET: ({ request }) => apiCatalogResponse(originOf(request)),
    },
  },
});
