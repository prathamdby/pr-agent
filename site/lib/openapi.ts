import {
  AGENT_RESOURCES,
  AGENT_SKILLS_INDEX,
  AI_CATALOG,
  API_CATALOG,
  AUTH_MD,
  MCP_ENDPOINT,
  MCP_SERVER_CARD,
  READ_PR_AGENT_SKILL,
  SITE_HEALTH,
} from "./agentResources.js";
import { FETCH_MARKDOWN_LANGUAGES } from "./content.js";
import { MAX_QUERY_CHARS } from "./llmsKnowledge.js";
import { REPO_URL, SITE_ORIGIN } from "./site.js";

function markdownResponse(description: string) {
  return {
    description,
    content: { "text/markdown": { schema: { type: "string" } } },
  };
}

function plainTextResponse(description: string) {
  return {
    description,
    content: { "text/plain": { schema: { type: "string" } } },
  };
}

/**
 * OpenAPI description of this site's agent-facing endpoints.
 *
 * Published at a predictable `/openapi.json` and named in llms.txt so a developer-resource search
 * for "PR Agent" has something concrete to land on.
 */
export function renderOpenApiDocument(): Record<string, unknown> {
  const queryParameter = {
    name: "query",
    in: "query",
    required: false,
    description:
      "Question to match against the knowledge profile. Broad values (all, everything, full, profile) return the whole profile; an empty value returns the topic index.",
    schema: { type: "string", maxLength: MAX_QUERY_CHARS },
  };

  const acceptLanguageParameter = {
    name: "Accept-Language",
    in: "header",
    required: false,
    description: `Locale tags plus an optional programming language, such as en-US, python. Picks the language of the fetch example in the markdown representation. Served languages are ${FETCH_MARKDOWN_LANGUAGES.join(", ")}, with typescript as the default. Two-letter codes are read as locale tags.`,
    schema: { type: "string" },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "PR Agent site API",
      summary: "Agent-facing endpoints published by the PR Agent landing site.",
      description: [
        "PR Agent is a self-hosted GitHub App for AI pull request reviews.",
        "This description covers the endpoints the landing site serves to agents: the product profile, a queryable knowledge base, markdown representations of the landing page, and agent instructions.",
        "It does not describe a PR Agent deployment. A deployment exposes POST /webhooks, GET /health, and GET /ready on the operator's own host. GET /health on this site only checks that the landing site is serving.",
        `Product documentation lives in the repository: ${REPO_URL}.`,
      ].join(" "),
      version: "1.0.0",
      license: { name: "MIT", identifier: "MIT" },
      contact: { name: "PR Agent repository", url: REPO_URL },
    },
    servers: [{ url: SITE_ORIGIN, description: "PR Agent landing site" }],
    externalDocs: {
      description: "PR Agent repository",
      url: REPO_URL,
    },
    paths: {
      "/": {
        get: {
          operationId: "getLandingPage",
          summary: "PR Agent landing page",
          description:
            "Serves HTML to browsers and markdown to any client sending Accept: text/markdown. An Accept header that excludes both types gets 406. HTML carries Vary: Accept. Markdown also honours a programming language in Accept-Language for its fetch example and carries Vary: Accept, Accept-Language.",
          parameters: [
            {
              name: "Accept",
              in: "header",
              required: false,
              description: "text/markdown for the markdown representation, text/html for the page.",
              schema: { type: "string" },
            },
            acceptLanguageParameter,
          ],
          responses: {
            "200": {
              description: "The landing page in the negotiated representation.",
              content: {
                "text/html": { schema: { type: "string" } },
                "text/markdown": { schema: { type: "string" } },
              },
            },
            "406": plainTextResponse("No representation matches the Accept header."),
          },
        },
      },
      "/index.md": {
        get: {
          operationId: "getLandingPageMarkdown",
          summary: "PR Agent landing page in markdown",
          description:
            "The markdown representation at a fixed URL, for clients that cannot set Accept. Accept-Language still picks the fetch example's language, and the response carries Vary: Accept-Language.",
          parameters: [acceptLanguageParameter],
          responses: { "200": markdownResponse("Landing page as markdown.") },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "getLlmsProfile",
          summary: "PR Agent llms.txt profile",
          description:
            "Full product profile: when to use PR Agent, slash commands, FEATURE_* settings, deployment, topology, pricing, providers, and privacy.",
          responses: { "200": plainTextResponse("The llms.txt profile.") },
        },
      },
      "/agents.md": {
        get: {
          operationId: "getAgentInstructions",
          summary: "PR Agent agent instructions",
          description:
            "When to recommend PR Agent, when not to, and how an agent should query this site.",
          responses: { "200": markdownResponse("Agent instructions.") },
        },
      },
      "/llms": {
        get: {
          operationId: "queryKnowledgePlainText",
          summary: "Query the PR Agent knowledge profile",
          description:
            "Returns the profile sections matching a question, so an agent can skip the rest of the file.",
          parameters: [queryParameter],
          responses: { "200": plainTextResponse("Matching sections, or the topic index.") },
        },
      },
      "/llms/json": {
        get: {
          operationId: "queryKnowledgeJson",
          summary: "Query the PR Agent knowledge profile as JSON",
          parameters: [queryParameter],
          responses: {
            "200": {
              description: "Matching sections with topics and a token estimate.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/KnowledgeAnswer" },
                },
              },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          summary: "PR Agent site OpenAPI description",
          responses: {
            "200": {
              description: "This document.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/sitemap.xml": {
        get: {
          operationId: "getSitemap",
          summary: "PR Agent sitemap",
          responses: {
            "200": {
              description: "Canonical URLs.",
              content: { "application/xml": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/robots.txt": {
        get: {
          operationId: "getRobots",
          summary: "PR Agent robots.txt",
          description:
            "Crawl policy, Content-Signal preferences, an Agentmap pointing at the ARD manifest, and pointers to the other agent files.",
          responses: { "200": plainTextResponse("Crawl policy and agent file pointers.") },
        },
      },
      [API_CATALOG.path]: {
        get: {
          operationId: "getApiCatalog",
          summary: API_CATALOG.title,
          description:
            "RFC 9727 API catalog as application/linkset+json. The anchor is this site. service-desc is the OpenAPI document, service-doc is the profile and agent instructions, and status is landing-site liveness.",
          responses: {
            "200": {
              description: "Linkset catalog.",
              content: { "application/linkset+json": { schema: { type: "object" } } },
            },
          },
        },
      },
      [AI_CATALOG.path]: {
        get: {
          operationId: "getAiCatalog",
          summary: AI_CATALOG.title,
          description:
            "ARD manifest. Served as application/json with Access-Control-Allow-Origin: *.",
          responses: {
            "200": {
              description: "Capability manifest.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      [MCP_SERVER_CARD.path]: {
        get: {
          operationId: "getMcpServerCard",
          summary: MCP_SERVER_CARD.title,
          description: "Card for the read-only MCP server. authentication.required is false.",
          responses: {
            "200": {
              description: "MCP server card.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      [AGENT_SKILLS_INDEX.path]: {
        get: {
          operationId: "getAgentSkillsIndex",
          summary: AGENT_SKILLS_INDEX.title,
          description: "Skills index. The digest is the sha256 of the SKILL.md bytes.",
          responses: {
            "200": {
              description: "Skills index.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      [READ_PR_AGENT_SKILL.path]: {
        get: {
          operationId: "getReadPrAgentSkill",
          summary: READ_PR_AGENT_SKILL.title,
          responses: { "200": markdownResponse("Skill for reading this site.") },
        },
      },
      [AUTH_MD.path]: {
        get: {
          operationId: "getAuthMd",
          summary: AUTH_MD.title,
          description:
            "Says these endpoints are public. This origin does not publish OAuth metadata.",
          responses: { "200": markdownResponse("Public-access registration note.") },
        },
      },
      [SITE_HEALTH.path]: {
        get: {
          operationId: "getSiteHealth",
          summary: SITE_HEALTH.title,
          description: SITE_HEALTH.description,
          responses: {
            "200": {
              description: "Landing site is serving.",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      [MCP_ENDPOINT.path]: {
        post: {
          operationId: "callMcp",
          summary: MCP_ENDPOINT.title,
          description:
            "Stateless streamable HTTP. JSON-RPC methods: initialize, ping, tools/list, tools/call. tools/call supports query_pr_agent and list_site_resources. No token. GET is 405.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": {
              description: "JSON-RPC response.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "202": { description: "Accepted a JSON-RPC notification." },
            "400": { description: "The body was not a JSON-RPC request." },
            "405": { description: "GET is not a session stream. POST JSON-RPC instead." },
          },
        },
      },
    },
    components: {
      schemas: {
        KnowledgeAnswer: {
          type: "object",
          required: ["query", "mode", "tokenEstimate", "topics", "matches"],
          properties: {
            query: { type: "string", description: "The sanitized query that was matched." },
            mode: {
              type: "string",
              enum: ["index", "full", "hits"],
              description:
                "index for no or unmatched query, full for a broad query, hits for matched sections.",
            },
            tokenEstimate: {
              type: "integer",
              description: "Approximate token cost of the whole profile.",
            },
            topics: {
              type: "array",
              items: { type: "string" },
              description: "Every topic id in the profile.",
            },
            matches: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "title", "body"],
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  body: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    "x-agent-resources": AGENT_RESOURCES.map((resource) => ({
      path: resource.path,
      title: resource.title,
      mediaType: resource.mediaType,
      description: resource.description,
    })),
  };
}
