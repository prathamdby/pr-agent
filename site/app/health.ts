import { createFileRoute } from "@tanstack/react-router";
import { siteHealthResponse } from "@/lib/agentDiscovery";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: () => siteHealthResponse(),
    },
  },
});
