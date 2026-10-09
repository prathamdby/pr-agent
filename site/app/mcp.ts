import { createFileRoute } from "@tanstack/react-router";
import { mcpMethodNotAllowed, mcpPostResponse } from "@/lib/mcpServer";

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      POST: ({ request }) => mcpPostResponse(request),
      GET: () => mcpMethodNotAllowed(),
    },
  },
});
