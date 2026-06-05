import type { BrandName } from "./components/integrations.types";

export const NAV_LINKS = [
  { label: "How it works", href: "#how" },
  { label: "Features", href: "#features" },
  { label: "Self-hosting", href: "#self-hosted" },
  { label: "FAQ", href: "#faq" },
] as const;

export const GITHUB_URL = "https://github.com/";

export const INTEGRATIONS: { name: BrandName; label: string }[] = [
  { name: "github", label: "GitHub" },
  { name: "cursor", label: "Cursor" },
  { name: "anthropic", label: "Anthropic" },
  { name: "gemini", label: "Google Gemini" },
  { name: "openrouter", label: "OpenRouter" },
  { name: "node", label: "Node.js" },
  { name: "docker", label: "Docker" },
  { name: "postgres", label: "PostgreSQL" },
];

export type Feature = {
  title: string;
  body: string;
  command: string;
};

export const FEATURES: Feature[] = [
  {
    title: "Reviews that explain themselves",
    body: "Every pull request opened or updated gets a review summary, with the most important issues marked inline from P0 to P2 so the riskiest changes are easy to spot.",
    command: "/review",
  },
  {
    title: "Descriptions written for you",
    body: "PR Agent drafts a clear summary, a short file walkthrough, and an optional diagram, then merges it into the pull request body without touching what you wrote.",
    command: "/describe",
  },
  {
    title: "A security pass on demand",
    body: "Ask for a focused security read when a change deserves one. It posts its own summary and never runs on its own, so it stays out of the way until you call it.",
    command: "/review-security",
  },
  {
    title: "A code quality pass on demand",
    body: "Want a closer look at structure and maintainability? The quality lens reviews the same change through a different set of eyes and keeps its notes separate.",
    command: "/review-quality",
  },
  {
    title: "Answers, right on the line",
    body: "Reply with a question on the conversation or on a specific line of the diff. PR Agent reads the code at that point and answers in plain language.",
    command: "/ask",
  },
];

export type Step = {
  title: string;
  body: string;
};

export const STEPS: Step[] = [
  {
    title: "A webhook arrives",
    body: "GitHub sends an event the moment a pull request opens, updates, or someone types a command. The web service records it and replies in milliseconds.",
  },
  {
    title: "The work is saved first",
    body: "Before anything else happens, the job is written to your Postgres database and queued. A busy review backlog can never drop an incoming event.",
  },
  {
    title: "A worker picks it up",
    body: "A separate worker checks out the pull request, reads the code with its tools, and runs the model you chose. Reviews and questions run on their own lanes.",
  },
  {
    title: "Results land on the PR",
    body: "The summary, inline notes, description, or answer is published straight to the pull request, the same place your team already works.",
  },
];

export type Faq = {
  q: string;
  a: string;
};

export const FAQS: Faq[] = [
  {
    q: "Where does my code go?",
    a: "Nowhere you do not control. PR Agent runs on your own servers with your own GitHub App credentials. Code is only sent to the model provider you configure, and only while a worker is actively reviewing a change.",
  },
  {
    q: "Which AI models can I use?",
    a: "Your choice. PR Agent works with providers like Anthropic, Google, OpenAI, OpenRouter, and others through its Pi runner, and it also supports the Cursor SDK. You set the provider and model with a couple of environment variables.",
  },
  {
    q: "Do I have to use slash commands?",
    a: "No. General reviews and descriptions run automatically whenever a pull request opens or updates. Commands like /ask, /review-security, and /review-quality are there for the moments you want something extra.",
  },
  {
    q: "Will it slow down GitHub or get rate limited?",
    a: "It is built to stay polite. Webhooks are accepted and stored before any heavy work begins, file and patch sizes are capped, and calls to GitHub are paced so large pull requests stay within limits.",
  },
  {
    q: "How do I run it?",
    a: "The quickest path is Docker Compose, which brings up Postgres, the web service, and the worker together. You can also run the Node services directly against your own Postgres. A health check endpoint tells your orchestrator when it is ready.",
  },
  {
    q: "What happens on a huge pull request?",
    a: "It keeps working and tells the truth. When a change set is too large to read in full, PR Agent reviews what fits and marks clearly that the set was trimmed, so a review is never silently incomplete.",
  },
];

export type Testimonial = {
  quote: string;
  name: string;
  role: string;
  initials: string;
};

export const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "We pointed it at our busiest repo on a Friday afternoon. By Monday it had caught two off-by-one bugs in draft PRs before anyone opened them for review.",
    name: "Mara Quinn",
    role: "Staff Engineer, payments team",
    initials: "MQ",
  },
  {
    quote:
      "The part I did not expect to love is the descriptions. New contributors read a clean summary instead of guessing what a forty file change actually does.",
    name: "Devon Okafor",
    role: "Engineering Lead",
    initials: "DO",
  },
  {
    quote:
      "It lives on our own boxes next to the database, so legal stopped asking questions. The security pass is something we now run before every release branch.",
    name: "Priya Nair",
    role: "Platform & Security",
    initials: "PN",
  },
  {
    quote:
      "Asking a question on a specific line and getting a grounded answer back has quietly replaced half of our review back and forth.",
    name: "Tomas Reyes",
    role: "Senior Backend Engineer",
    initials: "TR",
  },
];

export type Stat = {
  value: string;
  label: string;
};

export const STATS: Stat[] = [
  { value: "3", label: "review lenses, each with its own summary" },
  { value: "P0 to P2", label: "severity on the issues that matter" },
  { value: "100%", label: "self-hosted on your own infrastructure" },
  { value: "1", label: "place to read it all, the pull request" },
];
