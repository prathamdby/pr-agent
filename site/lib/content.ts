type FeatureItem = {
  title: string;
  detail: string;
  cue: string;
  summary: string;
};

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
    trigger: "Comment /triage on the pull request or on a finding thread",
    detail: "Checks open findings and can push fixes for valid same-repo issues.",
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
  {
    name: "Cursor models",
    detail: "Use Cursor models while keeping the reviews running on your own servers.",
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
      "Greptile is a cloud reviewer that indexes whole repositories. PR Agent is self-hosted and looks at each pull request from the branch and what changed. Pick it when you want the review data and models under your control, not another managed subscription.",
  },
  {
    question: "Does PR Agent replace Cursor Bugbot?",
    answer:
      "PR Agent fits teams that want bug and correctness reviews on GitHub without sending that work through Cursor's cloud review service. You can still use Cursor models as the AI backend. Bugbot stays tied to the Cursor IDE. PR Agent is a review system you operate.",
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
      "PR Agent works with OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Groq, and more, plus Cursor models. You pick the provider and set your own API key on the machine that runs reviews.",
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
    differentiator: "You run the reviewer, hold the model keys, and keep the review data.",
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
