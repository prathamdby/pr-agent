import type { BrandName } from "./components/integrations.types";

export const GITHUB_URL = "https://github.com/";

export const NAV_LINKS = [
  { label: "How it works", href: "#how" },
  { label: "What it does", href: "#capabilities" },
  { label: "Self-hosting", href: "#self-hosted" },
  { label: "FAQ", href: "#faq" },
] as const;

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

export const SEVERITIES = [
  { tag: "P0", label: "blocking", note: "ship-stoppers, called out first", tone: "danger" },
  { tag: "P1", label: "should fix", note: "real bugs worth a second look", tone: "warn" },
  { tag: "P2", label: "consider", note: "smaller notes, easy to skip", tone: "muted" },
] as const;

export type Faq = { q: string; a: string };

export const FAQS: Faq[] = [
  {
    q: "Where does my code go?",
    a: "Nowhere you do not control. PR Agent runs on your own servers with your own GitHub App credentials. Code is sent only to the model provider you configure, and only while a worker is actively reviewing a change.",
  },
  {
    q: "Which AI models can I use?",
    a: "Your choice. PR Agent works with providers like Anthropic, Google, OpenAI, and OpenRouter through its Pi runner, and it also supports the Cursor SDK. You set the provider and model with a couple of environment variables.",
  },
  {
    q: "Do I have to use slash commands?",
    a: "No. General reviews and descriptions run on their own whenever a pull request opens or updates. Commands like /ask, /review-security, and /review-quality are there for the moments you want something extra.",
  },
  {
    q: "Will it slow down GitHub or get rate limited?",
    a: "It is built to stay polite. Webhooks are accepted and stored before any heavy work begins, file and patch sizes are capped, and calls to GitHub are paced so large pull requests stay within limits.",
  },
  {
    q: "How do I run it?",
    a: "The quickest path is Docker Compose, which brings up Postgres, the web service, and the worker together. You can also run the Node services directly against your own Postgres. A health check tells your orchestrator when it is ready.",
  },
  {
    q: "What happens on a huge pull request?",
    a: "It keeps working and tells the truth. When a change set is too large to read in full, PR Agent reviews what fits and says clearly that the set was trimmed, so a review is never silently incomplete.",
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
      "It caught two off-by-one bugs in draft PRs over the weekend, before anyone opened them for review.",
    name: "Mara Quinn",
    role: "Staff Engineer, Payments",
    initials: "MQ",
  },
  {
    quote:
      "The descriptions are the surprise win. New contributors read a clean summary instead of guessing what a forty file change does.",
    name: "Devon Okafor",
    role: "Engineering Lead, Latchkey",
    initials: "DO",
  },
  {
    quote:
      "It runs next to our database on our own boxes, so legal stopped asking questions. The security pass now runs before every release branch.",
    name: "Priya Nair",
    role: "Platform and Security, Hartline",
    initials: "PN",
  },
  {
    quote:
      "Asking a question on one line and getting a grounded answer has replaced half of our review back and forth.",
    name: "Tomas Reyes",
    role: "Senior Backend Engineer",
    initials: "TR",
  },
];

export type Stat = { value: string; label: string };

export const STATS: Stat[] = [
  { value: "3", label: "review lenses, each with its own summary" },
  { value: "P0", label: "to P2 severity on what actually matters" },
  { value: "200ms", label: "to accept a webhook, before any model runs" },
  { value: "100%", label: "on infrastructure you own" },
];
