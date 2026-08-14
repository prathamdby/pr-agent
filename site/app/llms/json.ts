import { createFileRoute } from "@tanstack/react-router";
import { llmsQueryResponse } from "@/lib/llmsHttp";

export const Route = createFileRoute("/llms/json")({
  server: {
    handlers: {
      GET: ({ request }) => llmsQueryResponse(request, "json"),
    },
  },
});
