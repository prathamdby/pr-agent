import { REPO_URL } from "@/lib/site";

export const PRODUCT_NAME = "PR Agent";

export const SEO_TITLE = "PR Agent | AI PR Reviews on Your Own Servers";

export const SEO_DESCRIPTION =
  "AI reviews for GitHub pull requests on your servers. MIT-licensed, no per-seat fee, Docker Compose deploy, and bring your own model keys.";

export const SEO_KEYWORDS = [
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

export type FaqItem = {
  question: string;
  answer: string;
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What is PR Agent?",
    answer:
      "PR Agent reviews GitHub pull requests on your servers. You deploy webhook intake, a Postgres job queue, background workers, and AI agents. It posts one synthesized Review summary comment per Review run, PR descriptions, Triage reports, Verification outcomes on open findings, and Q&A replies back to GitHub.",
  },
  {
    question: "Is PR Agent a self-hosted alternative to CodeRabbit?",
    answer:
      "Yes. PR Agent covers GitHub Review runs on PR open by default (`REVIEW_AUTO_ACTIONS`), Verification on synchronize by default (`VERIFICATION_AUTO_ACTIONS`), inline comments, PR summaries, descriptions, Triage autofix, and slash-command triggers. Unlike CodeRabbit's hosted SaaS, PR Agent runs on your servers, uses your GitHub App credentials, and lets you bring your own LLM provider.",
  },
  {
    question: "How does PR Agent compare to Greptile?",
    answer:
      "Greptile is a cloud AI code reviewer that indexes full repositories for cross-file context. PR Agent is self-hosted and investigates each pull request from a shallow checkout of the PR head plus GitHub diff metadata. PR Agent fits teams that want data residency, infrastructure control, and open-source deployment instead of a managed Greptile subscription.",
  },
  {
    question: "Does PR Agent replace Cursor Bugbot?",
    answer:
      "PR Agent fits teams that want bug-and-correctness reviews on GitHub without Cursor's cloud review service. PR Agent supports the Cursor SDK as one LLM backend, so Cursor users keep familiar models while self-hosting the review pipeline. Bugbot remains tied to the Cursor IDE workflow; PR Agent is a review platform you operate.",
  },
  {
    question: "How does PR Agent compare to Macroscope?",
    answer:
      "Macroscope is a hosted AI code review product focused on GitHub pull requests. PR Agent offers a similar automated review and publish flow but as an MIT-licensed platform you deploy yourself. You control Postgres, queue workers, model choice, and where review data is processed.",
  },
  {
    question: "Is PR Agent free?",
    answer:
      "Yes. PR Agent is MIT-licensed software with no per-seat fee from PR Agent. You pay for your hosting, Postgres, and LLM token usage. Add 50 developers and your PR Agent software bill stays at $0.",
  },
  {
    question: "Which AI models does PR Agent support?",
    answer:
      "PR Agent supports Pi providers (OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more) and the Cursor SDK for Cursor models. You configure the provider with environment variables on your worker.",
  },
  {
    question: "Does PR Agent only work with GitHub?",
    answer:
      "Today PR Agent is a GitHub App. It listens for pull_request, issue_comment, and pull_request_review_comment webhooks and publishes reviews and replies on GitHub pull requests. GitLab and Bitbucket are not supported yet.",
  },
];

export type AlternativeRow = {
  name: string;
  deployment: string;
  differentiator: string;
};

export const ALTERNATIVE_ROWS: AlternativeRow[] = [
  {
    name: "PR Agent",
    deployment: "Self-hosted, MIT-licensed",
    differentiator: "Runs the reviewer, queue, model keys, and data path in your account.",
  },
  {
    name: "CodeRabbit",
    deployment: "Cloud SaaS (self-host enterprise)",
    differentiator: "Hosted reviewer with subscription pricing and a managed data path.",
  },
  {
    name: "Greptile",
    deployment: "Cloud SaaS (self-host option)",
    differentiator: "Managed full-repo indexing for cross-file context.",
  },
  {
    name: "Cursor Bugbot",
    deployment: "Cloud (Cursor ecosystem)",
    differentiator: "Bug-focused review tied to the Cursor ecosystem.",
  },
  {
    name: "Macroscope",
    deployment: "Cloud SaaS",
    differentiator: "Hosted GitHub PR review with a managed pipeline.",
  },
];

export function softwareApplicationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: PRODUCT_NAME,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "AI Code Review",
    operatingSystem: "Linux, Docker",
    description: SEO_DESCRIPTION,
    url: REPO_URL,
    downloadUrl: REPO_URL,
    softwareVersion: "0.1.0",
    license: "https://opensource.org/licenses/MIT",
    featureList: [
      "Automated multi-agent pull request Review runs",
      "PR description generation",
      "Verification of open findings on follow-up commits",
      "Triage autofix and repo policy suggestions",
      "Slash-command Q&A on pull requests",
      "Self-hosted GitHub App",
      "Bring your own LLM provider",
      "Durable webhook intake and job queue",
      "No per-seat software fee",
    ],
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "MIT-licensed software. No per-seat fee from PR Agent.",
    },
    author: {
      "@type": "Organization",
      name: "prathamdby",
      url: "https://github.com/prathamdby",
    },
    screenshot: "/screenshots/review.example.webp",
  };
}

export function webSiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: PRODUCT_NAME,
    description: SEO_DESCRIPTION,
    url: REPO_URL,
  };
}

export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "prathamdby",
    url: "https://github.com/prathamdby",
  };
}

export function faqPageJsonLd() {
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

export function itemListJsonLd() {
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
  webSiteJsonLd(),
  organizationJsonLd(),
  faqPageJsonLd(),
  itemListJsonLd(),
];
