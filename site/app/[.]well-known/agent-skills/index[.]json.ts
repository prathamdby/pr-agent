import { createFileRoute } from "@tanstack/react-router";
import { agentSkillsIndexResponse, originOf } from "@/lib/agentDiscovery";

export const Route = createFileRoute("/.well-known/agent-skills/index.json")({
  server: {
    handlers: {
      GET: ({ request }) => agentSkillsIndexResponse(originOf(request)),
    },
  },
});
