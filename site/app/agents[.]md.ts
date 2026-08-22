import { createFileRoute } from "@tanstack/react-router";
import { agentInstructionsResponse } from "@/lib/siteHttp";

export const Route = createFileRoute("/agents.md")({
  server: {
    handlers: {
      GET: () => agentInstructionsResponse(),
    },
  },
});
