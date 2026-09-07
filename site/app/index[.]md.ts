import { createFileRoute } from "@tanstack/react-router";
import { homeMarkdownDocumentResponse } from "@/lib/siteHttp";

export const Route = createFileRoute("/index.md")({
  server: {
    handlers: {
      GET: ({ request }) => homeMarkdownDocumentResponse(request.headers.get("Accept-Language")),
    },
  },
});
