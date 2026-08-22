import { KNOWLEDGE_QUERY_TEXT } from "@/lib/agentResources";
import { ALTERNATIVE_ROWS, FAQ_ITEMS, FEATURES } from "@/lib/content";
import { REPO_URL, SITE_ORIGIN } from "@/lib/site";

export const PRODUCT_NAME = "PR Agent";

/** Profile behind the repository, used as an entity anchor for brand-name queries. */
const AUTHOR_URL = "https://github.com/prathamdby";

/** Every URL that identifies this project, so search engines can tie the name to one entity. */
const SAME_AS = [REPO_URL, AUTHOR_URL];

export const SEO_TITLE = "PR Agent | AI PR reviews on Your Own Servers";

export const SEO_DESCRIPTION =
  "AI PR reviews for GitHub pull requests on your servers. MIT-licensed, no per-seat fee, deploy with Docker Compose, and bring your own model keys.";

export const SEO_KEYWORDS = [
  "AI PR reviews",
  "PR Agent",
  "AI code review",
  "AI pull request review",
  "self-hosted code review",
  "GitHub code review bot",
  "GitHub App code review",
  "open source code review",
  "CodeRabbit alternative",
  "Greptile alternative",
  "Cursor Bugbot alternative",
  "Macroscope alternative",
  "self-hosted CodeRabbit",
  "automated PR review",
  "AI PR reviewer",
  "pull request automation",
  "code review automation",
  "security code review",
  "PR description generator",
  "Docker code review",
];

function softwareApplicationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: PRODUCT_NAME,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "AI Code Review",
    operatingSystem: "Linux, Docker",
    description: SEO_DESCRIPTION,
    url: SITE_ORIGIN,
    downloadUrl: REPO_URL,
    softwareVersion: "0.1.0",
    license: "https://opensource.org/licenses/MIT",
    featureList: FEATURES.map((feature) => feature.summary),
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "MIT-licensed software. No per-seat fee from PR Agent.",
    },
    author: {
      "@type": "Organization",
      name: "prathamdby",
      url: AUTHOR_URL,
    },
    sameAs: SAME_AS,
    screenshot: `${SITE_ORIGIN}/og-image.png`,
  };
}

function faqPageJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

function itemListJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "AI code review tools compared to PR Agent",
    description:
      "How PR Agent compares to CodeRabbit, Greptile, Cursor Bugbot, and Macroscope for self-hosted GitHub pull request review.",
    itemListElement: ALTERNATIVE_ROWS.map((row, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: row.name,
      description: `${row.deployment}. ${row.differentiator}`,
    })),
  };
}

export const JSON_LD_GRAPHS = [
  softwareApplicationJsonLd(),
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: PRODUCT_NAME,
    alternateName: ["pr-agent", "PR Agent by prathamdby"],
    description: SEO_DESCRIPTION,
    url: SITE_ORIGIN,
    sameAs: SAME_AS,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE_ORIGIN}${KNOWLEDGE_QUERY_TEXT.path}{search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "prathamdby",
    url: AUTHOR_URL,
    sameAs: SAME_AS,
  },
  faqPageJsonLd(),
  itemListJsonLd(),
];
