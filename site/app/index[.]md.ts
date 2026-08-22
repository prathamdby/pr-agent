import { createFileRoute } from "@tanstack/react-router";
import { homeMarkdownDocumentResponse } from "@/lib/siteHttp";

export const Route = createFileRoute("/index.md")({
  server: {
    handlers: {
      GET: () => homeMarkdownDocumentResponse(),
    },
  },
});
