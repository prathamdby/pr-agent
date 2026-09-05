type FeatureItem = {
  title: string;
  detail: string;
  cue: string;
  summary: string;
};

/** Screen-reader H1. Leads with the product name so brand queries have something to match. */
export const HERO_HEADING = "PR Agent: AI PR reviews on your own servers";

export const HERO_SUPPORT =
  "Same first pass every PR gets, without a per-seat bill. You run the service and Postgres, and you own the GitHub App credentials and model keys. Model-backed work sends the review context to the provider you configure.";

export const HERO_CTA_NOTE = "MIT licensed. Hosting and AI usage on you.";

export const FEATURES: FeatureItem[] = [
  {
    title: "Deploy once on servers you control",
    detail:
      "Install PR Agent beside the rest of your stack. Your GitHub credentials and AI keys stay in your account, not a vendor dashboard.",
    cue: "Your servers · your keys",
    summary: "Self-hosted AI PR reviews",
  },
  {
    title: "Someone opens a pull request",
    detail:
      "PR Agent notices and starts a review. Your team sees a reaction on the pull request so everyone knows work has begun.",
    cue: "Starts when a pull request opens",
    summary: "Automated AI pull request reviews",
  },
  {
    title: "It reads what actually changed",
    detail:
      "PR Agent looks at the branch and the changes, then hunts for bugs and correctness issues. When risky APIs show up, it also checks for security problems.",
    cue: "Review runs on your servers",
    summary: "Reviews run on your servers",
  },
  {
    title: "Feedback shows up on the pull request",
    detail:
      "Notes appear next to the changed lines, plus a short summary in the conversation. Want more? Comment /describe, /ask, /triage, or mention the bot. Replies stay in the same thread.",
    cue: "/review · /describe · /ask · /triage",
    summary: "Reviews and replies posted in the pull request",
  },
  {
    title: "Honest limits when the change is huge",
    detail:
      "Docs-only pull requests can take a lighter path. Very large changes may get a partial review, and PR Agent says what it could not cover instead of faking completeness.",
    cue: "Partial review notice when needed",
    summary: "Honest coverage limits on large pull requests",
  },
];

type CapabilityItem = {
  title: string;
  trigger: string;
  detail: string;
};

export const CAPABILITIES: CapabilityItem[] = [
  {
    title: "Catch basics before a human opens the change",
    trigger: "Runs when a pull request opens, or when you comment /review",
    detail: "Comments land next to the lines that need attention.",
  },
  {
    title: "Turn a blank PR body into a readable summary",
    trigger: "Runs when a pull request opens, or when you comment /describe",
    detail: "Summary bullets and an optional diagram go into the PR body.",
  },
  {
    title: "Ask code questions without leaving GitHub",
    trigger: "Comment /ask … or mention the bot with your question",
    detail: "Get an answer in the same thread, right where the code lives.",
  },
  {
    title: "Revisit earlier findings on the pull request",
    trigger: "Comment /triage, or /triage preview then /triage all, on the pull request",
    detail:
      "Preview the would-be diff, then apply the approved set. Bare /triage still fixes without a preview.",
  },
  {
    title: "Skip AI review when the PR is only docs",
    trigger: "Runs automatically on small documentation-only changes",
    detail: "Docs-only pull requests take a lighter path instead of a full review.",
  },
];

type PricingPlan = {
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

type ProviderItem = {
  name: string;
  detail: string;
};

export const PROVIDERS: ProviderItem[] = [
  {
    name: "Many model providers",
    detail:
      "Use OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more with your own API keys.",
  },
];

type FaqItem = {
  question: string;
  answer: string;
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What is PR Agent?",
    answer:
      "PR Agent is open-source software that reviews GitHub pull requests on servers you run. You deploy it once, connect GitHub and an AI provider, and it posts reviews, summaries, and answers back on the pull request.",
  },
  {
    question: "Is PR Agent a self-hosted alternative to CodeRabbit?",
    answer:
      "Yes. It reviews pull requests when they open, leaves comments on the changes, writes summaries, and responds to commands in GitHub. Unlike CodeRabbit's hosted product, PR Agent runs on your servers with your credentials and your AI keys.",
  },
  {
    question: "How does PR Agent compare to Greptile?",
    answer:
      "Greptile is a cloud reviewer that indexes whole repositories. PR Agent is self-hosted and looks at each pull request from the branch and what changed. Pick it when you want to run the reviewer and choose the model provider, not another managed subscription.",
  },
  {
    question: "Does PR Agent replace Cursor Bugbot?",
    answer:
      "PR Agent fits teams that want bug and correctness reviews on GitHub without sending that work through a hosted IDE-tied review service. Bugbot stays tied to the Cursor IDE. PR Agent is a review system you operate with your own model keys.",
  },
  {
    question: "How does PR Agent compare to Macroscope?",
    answer:
      "Macroscope is a hosted AI code review product for GitHub pull requests. PR Agent offers a similar automatic review flow as MIT-licensed software you deploy yourself. You choose the models and where review data is processed.",
  },
  {
    question: "Is PR Agent free?",
    answer:
      "Yes. PR Agent is MIT-licensed with no per-seat fee from us. You pay for hosting and AI usage. Add 50 developers and the PR Agent software bill stays at $0.",
  },
  {
    question: "Which AI models does PR Agent support?",
    answer:
      "PR Agent works with OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more via the Pi provider catalog. You pick the provider and set your own API key on the machine that runs reviews.",
  },
  {
    question: "Does PR Agent only work with GitHub?",
    answer:
      "Yes for now. PR Agent connects as a GitHub app, reviews pull requests, and replies in GitHub comments. GitLab and Bitbucket are not supported yet.",
  },
];

type AlternativeRow = {
  name: string;
  deployment: string;
  differentiator: string;
};

export const ALTERNATIVE_ROWS: AlternativeRow[] = [
  {
    name: "PR Agent",
    deployment: "Self-hosted, MIT-licensed",
    differentiator: "You run the reviewer, hold the model keys, and choose the model provider.",
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

export const QUICKSTART_HEADING = "Deploy it with Docker Compose";

export const QUICKSTART_INTRO =
  "Three steps from an empty machine to a review on a real pull request. You need Docker, a GitHub app, and one AI provider key.";

type QuickstartStep = {
  n: string;
  title: string;
  body: string;
};

export const QUICKSTART_STEPS: readonly [QuickstartStep, QuickstartStep, QuickstartStep] = [
  {
    n: "01",
    title: "Create a GitHub app",
    body: "Register the app on your account or org, then point GitHub at the host where you will run PR Agent.",
  },
  {
    n: "02",
    title: "Fill .env and start the stack",
    body: "Copy the example env, drop in your GitHub app values and provider key, then start PR Agent with Compose.",
  },
  {
    n: "03",
    title: "Open a PR and talk to it",
    body: "Install the app on a repo, open a pull request, and wait for the automatic pass. Or type a command in the conversation when you want more.",
  },
];

export const APP_FIELDS = [
  {
    label: "Webhook URL",
    value: "https://<host>/webhooks",
    mono: true,
  },
  {
    label: "Subscribe to",
    value: "Pull requests · Issue comments · Pull request review comments",
    mono: false,
  },
  {
    label: "Permissions",
    value: "Issues and Pull requests: read/write · Contents: read/write · Metadata: read",
    mono: false,
  },
] as const;

export const SLASH_COMMANDS = [
  { cmd: "/review", tip: "Run a full review on the changes" },
  { cmd: "/describe", tip: "Write a readable summary into the PR body" },
  { cmd: "/ask …", tip: "Ask a question about the code in that thread" },
  { cmd: "/triage", tip: "Preview with /triage preview, apply with /triage all" },
  { cmd: "/triage preview", tip: "Show the would-be unified diff. Nothing is pushed." },
  { cmd: "/triage all", tip: "Apply the previewed set. Optional exclude <thread ids>." },
] as const;

export const COMPOSE_SNIPPET = `cp .env.example .env
# Fill GITHUB_*, WEBHOOK_SECRET, and your provider key
docker compose build
docker compose up`;

export const ENV_SNIPPET = `DATABASE_URL=postgres://...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
WEBHOOK_SECRET=...
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...`;
