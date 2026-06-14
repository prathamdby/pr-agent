import { REPO_URL } from "@/lib/site";

export const PRODUCT_NAME = "PR Agent";

export const SEO_TITLE = "PR Agent | Self-Hosted AI Code Review for GitHub";

export const SEO_DESCRIPTION =
  "Open-source, self-hosted AI pull request review platform for GitHub. Alternative to CodeRabbit, Greptile, Cursor Bugbot, and Macroscope. Bring your own model.";

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
      "PR Agent is an open-source, self-hosted AI pull request review platform for GitHub. You deploy webhook intake, a durable job queue, background workers, and AI agents on your own infrastructure. It publishes automated reviews, PR descriptions, security and quality reviews, and Q&A replies on pull requests.",
  },
  {
    question: "Is PR Agent a self-hosted alternative to CodeRabbit?",
    answer:
      "Yes. PR Agent covers the core CodeRabbit workflow on GitHub: automated reviews on PR open and sync, inline comments, PR summaries, descriptions, and slash-command triggers. Unlike CodeRabbit's hosted SaaS, PR Agent runs entirely on your servers, uses your GitHub App credentials, and lets you bring your own LLM provider.",
  },
  {
    question: "How does PR Agent compare to Greptile?",
    answer:
      "Greptile is a cloud AI code reviewer that indexes full repositories for cross-file context. PR Agent is self-hosted and investigates each pull request from a shallow checkout of the PR head plus GitHub diff metadata. PR Agent fits teams that want data residency, infrastructure control, and open-source deployment instead of a managed Greptile subscription.",
  },
  {
    question: "Can PR Agent replace Cursor Bugbot?",
    answer:
      "PR Agent can replace Bugbot for teams that want automated bug-and-correctness reviews on GitHub without Cursor's cloud review service. PR Agent supports the Cursor SDK as one LLM backend, so Cursor users can keep familiar models while self-hosting the review pipeline. Bugbot remains tighter to the Cursor IDE workflow; PR Agent is a full review platform you operate.",
  },
  {
    question: "How does PR Agent compare to Macroscope?",
    answer:
      "Macroscope is a hosted AI code review product focused on GitHub pull requests. PR Agent offers a similar automated review and publish flow but as an MIT-licensed platform you deploy yourself. You control Postgres, queue workers, model choice, and where review data is processed.",
  },
  {
    question: "Is PR Agent free?",
    answer:
      "PR Agent is open source under the MIT license. Software is free; you pay for your own hosting, Postgres, and LLM API usage. There is no per-developer SaaS fee from PR Agent itself.",
  },
  {
    question: "Which AI models does PR Agent support?",
    answer:
      "PR Agent supports many providers through Pi (OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more) and the Cursor SDK for Cursor models. You configure the provider with environment variables on your worker.",
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
    deployment: "Self-hosted (open source)",
    differentiator: "Full platform on your infra. BYO model. No per-seat fee.",
  },
  {
    name: "CodeRabbit",
    deployment: "Cloud SaaS (self-host enterprise)",
    differentiator: "Polished hosted reviewer. Multi-platform. Subscription pricing.",
  },
  {
    name: "Greptile",
    deployment: "Cloud SaaS (self-host option)",
    differentiator: "Full-repo indexing for cross-file context. Managed service.",
  },
  {
    name: "Cursor Bugbot",
    deployment: "Cloud (Cursor ecosystem)",
    differentiator: "Low-noise bug focus. Tight Cursor IDE integration.",
  },
  {
    name: "Macroscope",
    deployment: "Cloud SaaS",
    differentiator: "Hosted GitHub PR review. Managed pipeline.",
  },
];

export const JSON_LD_GRAPHS = [
  {
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
      "Automated AI pull request reviews",
      "PR description generation",
      "Security and quality review lenses",
      "Slash-command Q&A on pull requests",
      "Self-hosted GitHub App",
      "Bring your own LLM provider",
      "Durable webhook intake and job queue",
    ],
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Open source MIT license. Self-hosted.",
    },
    author: {
      "@type": "Organization",
      name: "prathamdby",
      url: "https://github.com/prathamdby",
    },
    screenshot: "/screenshots/review.example.webp",
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: PRODUCT_NAME,
    description: SEO_DESCRIPTION,
    url: REPO_URL,
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "prathamdby",
    url: "https://github.com/prathamdby",
  },
  {
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
  },
  {
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
  },
];
