import { createFileRoute } from "@tanstack/react-router";
import { agentInstructionsResponse, conditionalHeaders } from "@/lib/siteHttp";

export const Route = createFileRoute("/agents.md")({
  server: {
    handlers: {
      GET: ({ request }) => agentInstructionsResponse(conditionalHeaders(request)),
    },
  },
});
