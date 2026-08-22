import { AGENT_RESOURCES } from "./agentResources.js";
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

  return {
    openapi: "3.1.0",
    info: {
      title: "PR Agent site API",
      summary: "Agent-facing endpoints published by the PR Agent landing site.",
      description: [
        "PR Agent is a self-hosted GitHub App for AI pull request reviews.",
        "This description covers the endpoints the landing site serves to agents: the product profile, a queryable knowledge base, markdown representations of the landing page, and agent instructions.",
        "It does not describe a PR Agent deployment. A deployment exposes POST /webhooks, GET /health, and GET /ready on the operator's own host.",
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
            "Serves HTML to browsers and markdown to any client sending Accept: text/markdown. Responses carry Vary: Accept; an Accept header that excludes both types gets 406.",
          parameters: [
            {
              name: "Accept",
              in: "header",
              required: false,
              description: "text/markdown for the markdown representation, text/html for the page.",
              schema: { type: "string" },
            },
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
            "The markdown representation at a fixed URL, for clients that cannot negotiate.",
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
          responses: { "200": plainTextResponse("Crawl policy and agent file pointers.") },
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
