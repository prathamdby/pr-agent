import { createFileRoute } from "@tanstack/react-router";
import { createHealthResponse } from "@/lib/health";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: () => createHealthResponse(),
    },
  },
});
