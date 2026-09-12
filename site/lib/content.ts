import {
  DEFAULT_PROGRAMMING_LANGUAGE,
  PROGRAMMING_LANGUAGES,
  type ProgrammingLanguage,
  type ServableLanguages,
} from "./acceptLanguage.js";
import { SITE_ORIGIN } from "./site.js";

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
      "Notes appear next to the changed lines, plus a short summary in the conversation. Want more? Comment /describe, /ask, /triage, or mention the App bot. Replies stay in the same thread.",
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
    trigger: "Comment /ask … or mention the GitHub App bot with your question",
    detail: "The word @bot only matches if you named the App that. /ask does not need a mention.",
  },
  {
    title: "Recheck open findings after each push",
    trigger: "Runs after each new push when that option is left on, or when you comment /verify",
    detail:
      "The default setting uses tokens on every push. Switch it to on-demand if the bill is too high.",
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
  {
    question: "Where should I host PR Agent?",
    answer:
      "On a VPS you control, then put HTTPS in front of the web process. A panel such as Dokploy or Coolify can give you a domain and a certificate. Hetzner is a common cheap pick. Hostinger and DigitalOcean also work. The App still needs the same Compose stack. The panel does not replace it.",
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

export const QUICKSTART_HEADING = "Installation";

export const QUICKSTART_INTRO =
  "Three steps from a fresh machine to a review on a real pull request. You need Docker, a GitHub App, and one AI provider key. GitHub must reach your host over HTTPS, or you run a tunnel on a laptop. A VPS panel such as Dokploy or Coolify can supply the domain and the certificate.";

type QuickstartStep = {
  n: string;
  title: string;
  body: string;
};

export const QUICKSTART_STEPS: readonly [QuickstartStep, QuickstartStep, QuickstartStep] = [
  {
    n: "01",
    title: "Create a GitHub app",
    body: "Register the app, generate a private key, then install it on the test repo. Creating the app is not enough. If you pick only selected repositories, include that repo.",
  },
  {
    n: "02",
    title: "Fill .env and start the stack",
    body: "Copy the example env. Paste the generated App private key as one line, the webhook secret, and a provider key. Then start PR Agent with Compose. The example key is not a real key.",
  },
  {
    n: "03",
    title: "Open a PR and comment /help",
    body: "Open a pull request on an installed repo. Comment /help as a repo owner, member, or collaborator. Other accounts get no reply even though GitHub accepted the webhook.",
  },
];

export const APP_FIELDS = [
  {
    label: "Webhook URL",
    value: "https://<host>/webhooks",
    mono: true,
  },
  {
    label: "Homepage URL",
    value: "This repository or your public site. Leave user login off.",
    mono: false,
  },
  {
    label: "Subscribe to",
    value:
      "Pull requests, issue comments, pull request review comments, workflow runs, and check suites",
    mono: false,
  },
  {
    label: "Permissions",
    value:
      "Issues and pull requests: read and write. Repository contents: read and write. Metadata: read. Checks: read and write. Actions: read. Commit statuses only if you turn on commit-status posting.",
    mono: false,
  },
] as const;

export const SLASH_COMMANDS = [
  { cmd: "/review", tip: "Run a full review on the changes" },
  { cmd: "/describe", tip: "Write a readable summary into the PR body" },
  { cmd: "/ask …", tip: "Ask a question about the code in that thread" },
  { cmd: "/triage", tip: "Apply fixes and push. Preview is optional." },
  { cmd: "/triage preview", tip: "Show the would-be unified diff. Nothing is pushed." },
  {
    cmd: "/triage all",
    tip: "Apply the previewed set for this head. Refused without a matching preview.",
  },
] as const;

export const COMPOSE_SNIPPET = `cp .env.example .env
# Fill a real one-line GitHub App PEM, WEBHOOK_SECRET, and your provider key
docker compose build
docker compose up -d`;

export const ENV_SNIPPET = `GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
WEBHOOK_SECRET=...
PI_PROVIDER=openai
PI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...`;

type Variants = Readonly<Partial<Record<ProgrammingLanguage, string>>> &
  Readonly<Record<typeof DEFAULT_PROGRAMMING_LANGUAGE, string>>;

/**
 * A code example with one body per language it can be served in.
 *
 * The default language's body is required, so a request for a language the example lacks still
 * has something to render without a runtime check.
 */
export type VariantSnippet = {
  readonly variants: Variants;
};

/** Languages the snippet has a body for, default first, then allowlist order. */
export function servableLanguages(snippet: VariantSnippet): ServableLanguages {
  const rest = PROGRAMMING_LANGUAGES.filter(
    (language) =>
      language !== DEFAULT_PROGRAMMING_LANGUAGE && snippet.variants[language] !== undefined,
  );
  return [DEFAULT_PROGRAMMING_LANGUAGE, ...rest];
}

/** The body to render for a negotiated language, falling back to the default body. */
export function pickSnippet(
  snippet: VariantSnippet,
  preferred: ProgrammingLanguage,
): { language: ProgrammingLanguage; body: string } {
  const body = snippet.variants[preferred];
  if (body === undefined) {
    return {
      language: DEFAULT_PROGRAMMING_LANGUAGE,
      body: snippet.variants[DEFAULT_PROGRAMMING_LANGUAGE],
    };
  }
  return { language: preferred, body };
}

const MARKDOWN_URL = `${SITE_ORIGIN}/`;

export const FETCH_MARKDOWN_SNIPPET: VariantSnippet = {
  variants: {
    typescript: `const response = await fetch("${MARKDOWN_URL}", {
  headers: { Accept: "text/markdown", "Accept-Language": "en-US, typescript" },
});
const markdown: string = await response.text();`,
    javascript: `const response = await fetch("${MARKDOWN_URL}", {
  headers: { Accept: "text/markdown", "Accept-Language": "en-US, javascript" },
});
const markdown = await response.text();`,
    python: `from urllib.request import Request, urlopen

request = Request(
    "${MARKDOWN_URL}",
    headers={"Accept": "text/markdown", "Accept-Language": "en-US, python"},
)
with urlopen(request) as response:
    markdown = response.read().decode("utf-8")`,
    go: `req, _ := http.NewRequest(http.MethodGet, "${MARKDOWN_URL}", nil)
req.Header.Set("Accept", "text/markdown")
req.Header.Set("Accept-Language", "en-US, go")
resp, err := http.DefaultClient.Do(req)
if err != nil {
	log.Fatal(err)
}
defer resp.Body.Close()
markdown, err := io.ReadAll(resp.Body)
if err != nil {
	log.Fatal(err)
}`,
    java: `HttpClient client = HttpClient.newHttpClient();
HttpRequest request = HttpRequest.newBuilder(URI.create("${MARKDOWN_URL}"))
    .header("Accept", "text/markdown")
    .header("Accept-Language", "en-US, java")
    .build();
String markdown = client.send(request, HttpResponse.BodyHandlers.ofString()).body();`,
    ruby: `require "net/http"

uri = URI("${MARKDOWN_URL}")
http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = uri.scheme == "https"
request = Net::HTTP::Get.new(uri)
request["Accept"] = "text/markdown"
request["Accept-Language"] = "en-US, ruby"
markdown = http.request(request).body`,
    bash: `curl -sS -H 'Accept: text/markdown' -H 'Accept-Language: en-US, bash' ${MARKDOWN_URL}`,
  },
};

/** Server preference for the landing page's code example. `/` and `/index.md` negotiate against this set. */
export const FETCH_MARKDOWN_LANGUAGES = servableLanguages(FETCH_MARKDOWN_SNIPPET);
