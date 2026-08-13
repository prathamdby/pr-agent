import { JSON_LD_GRAPHS } from "@/lib/seo";

function omitJsonLdContext<T extends { readonly "@context": string }>(
  node: T,
): Omit<T, "@context"> {
  const { "@context": _ctx, ...rest } = node;
  return rest;
}

export function JsonLd() {
  const payload = {
    "@context": "https://schema.org",
    "@graph": JSON_LD_GRAPHS.map(omitJsonLdContext),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(payload) }}
    />
  );
}
