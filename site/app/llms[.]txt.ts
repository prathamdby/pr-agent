import { createFileRoute } from "@tanstack/react-router";
import { conditionalHeaders, llmsProfileResponse } from "@/lib/siteHttp";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: ({ request }) => llmsProfileResponse(conditionalHeaders(request)),
    },
  },
});
