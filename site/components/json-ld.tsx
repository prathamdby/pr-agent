import { JSON_LD_GRAPHS } from "@/lib/seo";

export function JsonLd() {
  const payload = {
    "@context": "https://schema.org",
    "@graph": JSON_LD_GRAPHS.map((node) => {
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
