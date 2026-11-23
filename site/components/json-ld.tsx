import { jsonLdGraphs } from "@/lib/seo";
import { pageOrigin } from "@/lib/site";

export function JsonLd() {
  const payload = {
    "@context": "https://schema.org",
    "@graph": jsonLdGraphs(pageOrigin()).map((node) => {
      const { "@context": _ctx, ...rest } = node as {
        "@context"?: string;
        [key: string]: unknown;
      };
      return rest;
    }),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(payload) }}
    />
  );
}
