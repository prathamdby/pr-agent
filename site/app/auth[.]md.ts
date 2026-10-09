import { createFileRoute } from "@tanstack/react-router";
import { authMarkdownResponse } from "@/lib/agentDiscovery";

export const Route = createFileRoute("/auth.md")({
  server: {
    handlers: {
      GET: () => authMarkdownResponse(),
    },
  },
});
