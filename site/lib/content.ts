export type FeatureItem = {
  title: string;
  detail: string;
  /** Short phrase shown under the step (command, event, or outcome). */
  cue: string;
  /** Short phrase for schema.org SoftwareApplication.featureList */
  summary: string;
};

/**
 * Walkthrough of what happens after deploy - instructional, not a feature laundry list.
 */
export const FEATURES: FeatureItem[] = [
  {
    title: "Deploy once on infrastructure you control",
    detail:
      "Stand up the GitHub App, Postgres, and workers. Your installation credentials and model keys stay in your environment - not a vendor account.",
    cue: "Your servers · your keys",
    summary: "Self-hosted GitHub App",
  },
  {
    title: "A pull request opens",
    detail:
      "GitHub delivers a signed webhook. PR Agent records it, reacts with eyes so the team knows work started, and queues a review for that head.",
    cue: "pull_request opened",
    summary: "Automated AI pull request reviews",
  },
  {
    title: "A worker inspects the change set",
    detail:
      "The agent checks out the PR head, reads the diff, and looks for bugs and correctness issues. When the diff touches dangerous APIs, it also hunts for security tripwires.",
    cue: "Local PR workspace on the worker",
    summary: "Reviews run on your workers",
  },
  {
    title: "Results land in the pull request",
    detail:
      "Inline threads show up on Files changed. A review summary lands in the conversation. Need more? Comment /describe, /review-security, /review-quality, /ask, or @-mention the bot - answers stay in the same thread.",
    cue: "/review · /describe · /ask · @bot",
    summary: "Reviews and replies posted in the pull request",
  },
  {
    title: "Honest limits when the change is huge",
    detail:
      "Docs-only pull requests can take a lighter path. Very large changes may get a partial review - and PR Agent says what it could not cover instead of faking completeness.",
    cue: "Partial review notice when needed",
    summary: "Honest coverage limits on large pull requests",
  },
];

export type CapabilityItem = {
  title: string;
  trigger: string;
  detail: string;
};

export const CAPABILITIES: CapabilityItem[] = [
  {
    title: "Catch review basics before a human opens the diff",
    trigger: "Runs when a PR opens, or when you comment /review",
    detail: "Inline comments appear on the Files changed tab.",
  },
  {
    title: "Turn a blank PR body into a readable summary",
    trigger: "Runs when a PR opens, or when you comment /describe",
    detail: "Summary bullets and an optional diagram go into the PR body.",
  },
  {
    title: "Ask for a security pass when the change touches risk",
    trigger: "Comment /review-security on the PR",
    detail: "Security notes are posted as a separate summary.",
  },
  {
    title: "Ask for a quality pass before merge",
    trigger: "Comment /review-quality on the PR",
    detail: "Maintainability notes land in the PR conversation.",
  },
  {
    title: "Ask code questions without leaving GitHub",
    trigger: "Comment /ask … or @-mention the bot with your question",
    detail: "Get an answer in the same thread, right where the code lives.",
  },
  {
    title: "Skip AI review when the PR is only docs",
    trigger: "Runs automatically on small documentation-only changes",
    detail: "Docs-only pull requests take a lighter path instead of a full review.",
  },
];

export type PricingPlan = {
  title: string;
  price: string;
  detail: string;
};

export const PRICING_PLANS: PricingPlan[] = [
  {
    title: "Software is free",
    price: "$0 from PR Agent",
    detail: "No credit card. No per-seat fee. Open source under MIT.",
  },
  {
    title: "You pay your own vendors",
    price: "Hosting and AI usage only",
    detail:
      "Cover your server, database, and model bills. Add more developers without raising your PR Agent bill.",
  },
  {
    title: "You own the full stack",
    price: "Your security rules apply",
    detail:
      "Run it inside your network, choose your AI provider, and keep review traffic under your policies.",
  },
];

export type ProviderItem = {
  name: string;
  detail: string;
};

export const PROVIDERS: ProviderItem[] = [
  {
    name: "Many model providers",
    detail:
      "Use OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more with your own API keys.",
  },
  {
    name: "Cursor models",
    detail: "Use Cursor models while keeping the review pipeline on your own servers.",
  },
];

export type FaqItem = {
  question: string;
  answer: string;
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What is PR Agent?",
    answer:
      "PR Agent reviews GitHub pull requests on your servers. You deploy webhook intake, a Postgres job queue, background workers, and AI agents. It posts reviews, PR descriptions, security notes, quality notes, and Q&A replies back to GitHub.",
  },
  {
    question: "Is PR Agent a self-hosted alternative to CodeRabbit?",
    answer:
      "Yes. PR Agent covers GitHub reviews on PR open, verification on sync, inline comments, PR summaries, descriptions, and slash-command triggers. Unlike CodeRabbit's hosted SaaS, PR Agent runs on your servers, uses your GitHub App credentials, and lets you bring your own LLM provider.",
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
