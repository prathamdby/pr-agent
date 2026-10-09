import { createFileRoute } from "@tanstack/react-router";
import { skillMarkdownResponse } from "@/lib/agentDiscovery";

export const Route = createFileRoute("/.well-known/agent-skills/read-pr-agent/SKILL.md")({
  server: {
    handlers: {
      GET: () => skillMarkdownResponse(),
    },
  },
});
