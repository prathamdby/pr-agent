import { createFileRoute } from "@tanstack/react-router";
import { llmsQueryResponse } from "@/lib/llmsHttp";

export const Route = createFileRoute("/llms/")({
  server: {
    handlers: {
      GET: ({ request }) => llmsQueryResponse(request, "text"),
    },
  },
});
