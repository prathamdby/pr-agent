import { createFileRoute } from "@tanstack/react-router";
import { aiCatalogResponse, originOf } from "@/lib/agentDiscovery";

export const Route = createFileRoute("/.well-known/ai-catalog.json")({
  server: {
    handlers: {
      GET: ({ request }) => aiCatalogResponse(originOf(request)),
    },
  },
});
