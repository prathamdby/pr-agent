import { createFileRoute } from "@tanstack/react-router";
import { mcpServerCardResponse, originOf } from "@/lib/agentDiscovery";

export const Route = createFileRoute("/.well-known/mcp/server-card.json")({
  server: {
    handlers: {
      GET: ({ request }) => mcpServerCardResponse(originOf(request)),
    },
  },
});
