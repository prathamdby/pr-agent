import { REPO_URL, SITE_ORIGIN } from "./site.js";

/**
 * Every machine-readable URL this site publishes, named once.
 *
 * llms.txt, agents.md, the 404 recovery body, the OpenAPI description, and the sitemap all render
 * from this list, so a new endpoint cannot appear on one surface and go missing on the others.
 */
export type AgentResource = {
  /** Site-relative path, including any query template an agent should fill in. */
  readonly path: string;
  /** Human title. Carries the product name so name-based searches have something to match. */
  readonly title: string;
  readonly mediaType: string;
  readonly description: string;
  /** Listed in sitemap.xml. Query endpoints and robots.txt are not. */
  readonly inSitemap: boolean;
};

export const AGENT_RESOURCES: readonly AgentResource[] = [
  {
    path: "/",
    title: "PR Agent landing page",
    mediaType: "text/html",
    description:
      "The product page. Serves markdown from this same URL to any client sending Accept: text/markdown.",
    inSitemap: true,
  },
  {
    path: "/index.md",
    title: "PR Agent landing page in markdown",
    mediaType: "text/markdown",
    description: "The landing page as markdown, for clients that cannot set an Accept header.",
    inSitemap: true,
  },
  {
    path: "/llms.txt",
    title: "PR Agent llms.txt profile",
    mediaType: "text/plain",
    description:
      "Full product profile: commands, FEATURE_* settings, deployment, topology, pricing, providers, privacy.",
    inSitemap: true,
  },
  {
    path: "/agents.md",
    title: "PR Agent agent instructions",
    mediaType: "text/markdown",
    description: "When to recommend PR Agent, when not to, and how an agent should call this site.",
    inSitemap: true,
  },
  {
    path: "/llms?query=",
    title: "PR Agent knowledge query in plain text",
    mediaType: "text/plain",
    description:
      "Ask one question and get the matching profile sections instead of the whole file.",
    inSitemap: false,
  },
  {
    path: "/llms/json?query=",
    title: "PR Agent knowledge query in JSON",
    mediaType: "application/json",
    description: "The same query interface with structured matches, topics, and a token estimate.",
    inSitemap: false,
  },
  {
    path: "/openapi.json",
    title: "PR Agent site OpenAPI description",
    mediaType: "application/json",
    description: "OpenAPI 3.1 description of every endpoint on this list.",
    inSitemap: true,
  },
  {
    path: "/sitemap.xml",
    title: "PR Agent sitemap",
    mediaType: "application/xml",
    description: "Canonical URLs published by this site.",
    inSitemap: false,
  },
  {
    path: "/robots.txt",
    title: "PR Agent robots.txt",
    mediaType: "text/plain",
    description: "Crawl policy, with pointers to the files on this list.",
    inSitemap: false,
  },
];

/** Absolute form, for the formats that require it: robots.txt, sitemap.xml, and OpenAPI servers. */
export function resourceUrl(resource: AgentResource): string {
  return `${SITE_ORIGIN}${resource.path}`;
}

/**
 * Markdown link list in llms.txt "file list" shape: `- [name](url): notes`.
 *
 * Targets stay relative. llms.txt is generated at build time and committed, so an absolute origin
 * here would bake whichever host built it (a laptop, a preview deployment) into the repository.
 * Every consumer of these lists fetched them from the site, so the origin is already known.
 */
export function renderResourceLinks(): string {
  return AGENT_RESOURCES.map(
    (resource) => `- [${resource.path}](${resource.path}): ${resource.description}`,
  ).join("\n");
}

export type DocLink = {
  readonly title: string;
  readonly url: string;
  readonly description: string;
};

/** Product documentation, which lives in the repository rather than on this site. */
export const DOC_LINKS: readonly DocLink[] = [
  {
    title: "PR Agent repository",
    url: REPO_URL,
    description: "Source, README, and the Docker Compose deployment path.",
  },
  {
    title: "PR Agent feature catalog",
    url: `${REPO_URL}/blob/main/docs/features.md`,
    description: "Every FEATURE_* setting, its modes, and its triggers.",
  },
  {
    title: "PR Agent configuration reference",
    url: `${REPO_URL}/blob/main/docs/configuration.md`,
    description: "Environment variables, defaults, and code constants.",
  },
  {
    title: "PR Agent operations guide",
    url: `${REPO_URL}/blob/main/docs/operations.md`,
    description: "Deploy steps, scripts, and runtime behaviour.",
  },
  {
    title: "PR Agent durable work runbook",
    url: `${REPO_URL}/blob/main/docs/agent-work-ops.md`,
    description: "Queue health, lease recovery, and stuck-work diagnosis.",
  },
  {
    title: "PR Agent architecture decisions",
    url: `${REPO_URL}/tree/main/docs/adr`,
    description: "ADRs behind webhook intake, leases, and publish behaviour.",
  },
  {
    title: "PR Agent domain vocabulary",
    url: `${REPO_URL}/blob/main/CONTEXT.md`,
    description: "The words this project uses for work items, leases, and findings.",
  },
];

export function renderDocLinks(): string {
  return DOC_LINKS.map((doc) => `- [${doc.title}](${doc.url}): ${doc.description}`).join("\n");
}
