import {
  AGENT_INSTRUCTIONS,
  AGENT_SKILLS_INDEX,
  API_CATALOG,
  LANDING_PAGE,
  LLMS_TXT_PROFILE,
  MCP_SERVER_CARD,
  OPENAPI_DOCUMENT,
  READ_PR_AGENT_SKILL,
  SITE_HEALTH,
} from "./agentResources.ts";
import { requestOrigin } from "./site.ts";
import { DOCUMENT_CACHE_CONTROL } from "./siteHttp.ts";

export const API_CATALOG_PROFILE = "https://www.rfc-editor.org/info/rfc9727";

export const API_CATALOG_CONTENT_TYPE = `${API_CATALOG.mediaType}; charset=utf-8; profile="${API_CATALOG_PROFILE}"`;

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

const AI_CATALOG_SPEC_VERSION = "1.0";

const MCP_SERVER_NAME = "pr-agent-site";
const MCP_SERVER_VERSION = "1.0.0";

const SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

export function originOf(request: Request) {
  return ((pinnedReturn: string) => pinnedReturn)(requestOrigin(request));
}

function jsonDocument(value: unknown) {
  return ((pinnedReturn: string) => pinnedReturn)(`${JSON.stringify(value, null, 2)}\n`);
}

export function documentResponse(
  body: string,
  contentType: string,
  extra?: { readonly cors?: boolean; readonly varyHost?: boolean },
) {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": DOCUMENT_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
  });
  if (extra?.cors === true) {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  if (extra?.varyHost === true) {
    headers.set("Vary", "Host");
  }
  return ((pinnedReturn: Response) => pinnedReturn)(new Response(body, { headers }));
}

export function renderApiCatalog(origin: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    jsonDocument({
      linkset: [
        {
          anchor: `${origin}${LANDING_PAGE.path}`,
          "service-desc": [
            {
              href: `${origin}${OPENAPI_DOCUMENT.path}`,
              type: OPENAPI_DOCUMENT.mediaType,
              title: OPENAPI_DOCUMENT.title,
            },
          ],
          "service-doc": [
            {
              href: `${origin}${LLMS_TXT_PROFILE.path}`,
              type: LLMS_TXT_PROFILE.mediaType,
              title: LLMS_TXT_PROFILE.title,
            },
            {
              href: `${origin}${AGENT_INSTRUCTIONS.path}`,
              type: AGENT_INSTRUCTIONS.mediaType,
              title: AGENT_INSTRUCTIONS.title,
            },
          ],
          status: [
            {
              href: `${origin}${SITE_HEALTH.path}`,
              type: SITE_HEALTH.mediaType,
              title: SITE_HEALTH.title,
            },
          ],
        },
      ],
    }),
  );
}

export function apiCatalogResponse(origin: string) {
  return ((pinnedReturn: Response) => pinnedReturn)(
    documentResponse(renderApiCatalog(origin), API_CATALOG_CONTENT_TYPE, { varyHost: true }),
  );
}

function catalogHost(origin: string) {
  const url = new URL(origin);
  return ((pinnedReturn: string) => pinnedReturn)(
    url.port === "" ? url.hostname : `${url.hostname}%3A${url.port}`,
  );
}

function didWeb(origin: string) {
  return ((pinnedReturn: string) => pinnedReturn)(`did:web:${catalogHost(origin)}`);
}

type CatalogEntry = {
  readonly identifier: string;
  readonly displayName: string;
  readonly type: string;
  readonly url: string;
  readonly representativeQueries: readonly string[];
};

function catalogEntry(
  host: string,
  namespace: string,
  name: string,
  displayName: string,
  type: string,
  url: string,
  representativeQueries: readonly string[],
) {
  return ((pinnedReturn: CatalogEntry) => pinnedReturn)({
    identifier: `urn:air:${host}:${namespace}:${name}`,
    displayName,
    type,
    url,
    representativeQueries,
  });
}

export function renderAiCatalog(origin: string) {
  const host = catalogHost(origin);
  const entries: readonly CatalogEntry[] = [
    catalogEntry(
      host,
      "profile",
      "llms-txt",
      LLMS_TXT_PROFILE.title,
      LLMS_TXT_PROFILE.mediaType,
      `${origin}${LLMS_TXT_PROFILE.path}`,
      [
        "what is PR Agent",
        "how do I install PR Agent",
        "which FEATURE settings does PR Agent have",
      ],
    ),
    catalogEntry(
      host,
      "api",
      "openapi",
      OPENAPI_DOCUMENT.title,
      OPENAPI_DOCUMENT.mediaType,
      `${origin}${OPENAPI_DOCUMENT.path}`,
      [
        "what endpoints does the PR Agent site expose",
        "where is the OpenAPI description",
        "how do I query the knowledge profile",
      ],
    ),
    catalogEntry(
      host,
      "profile",
      "agents-md",
      AGENT_INSTRUCTIONS.title,
      AGENT_INSTRUCTIONS.mediaType,
      `${origin}${AGENT_INSTRUCTIONS.path}`,
      [
        "when should I recommend PR Agent",
        "when is PR Agent the wrong tool",
        "how should an agent read this site",
      ],
    ),
    catalogEntry(
      host,
      "mcp",
      "server-card",
      MCP_SERVER_CARD.title,
      MCP_SERVER_CARD.mediaType,
      `${origin}${MCP_SERVER_CARD.path}`,
      [
        "where is the PR Agent MCP server",
        "what tools does the site MCP server expose",
        "does the landing site MCP server need a token",
      ],
    ),
    catalogEntry(
      host,
      "skills",
      "index",
      AGENT_SKILLS_INDEX.title,
      AGENT_SKILLS_INDEX.mediaType,
      `${origin}${AGENT_SKILLS_INDEX.path}`,
      [
        "which agent skills does this site publish",
        "how do I read the PR Agent skill",
        "what is the sha256 of the site skill",
      ],
    ),
  ];
  return ((pinnedReturn: string) => pinnedReturn)(
    jsonDocument({
      specVersion: AI_CATALOG_SPEC_VERSION,
      host: {
        displayName: "PR Agent",
        identifier: didWeb(origin),
      },
      entries,
    }),
  );
}

export function aiCatalogResponse(origin: string) {
  return ((pinnedReturn: Response) => pinnedReturn)(
    documentResponse(renderAiCatalog(origin), JSON_CONTENT_TYPE, {
      cors: true,
      varyHost: true,
    }),
  );
}

export function renderMcpServerCard(origin: string) {
  return ((pinnedReturn: string) => pinnedReturn)(
    jsonDocument({
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
      description:
        "Read-only knowledge server for the PR Agent landing site. It answers questions about the product. It does not review pull requests.",
      transport: {
        type: "streamable-http",
        endpoint: "/mcp",
      },
      capabilities: {
        tools: {},
      },
      authentication: {
        required: false,
      },
      documentationUrl: `${origin}${LLMS_TXT_PROFILE.path}`,
    }),
  );
}

export function mcpServerCardResponse(origin: string) {
  return ((pinnedReturn: Response) => pinnedReturn)(
    documentResponse(renderMcpServerCard(origin), JSON_CONTENT_TYPE, { varyHost: true }),
  );
}

export function renderReadPrAgentSkill() {
  return ((pinnedReturn: string) => pinnedReturn)(`---
name: read-pr-agent
description: Read the PR Agent landing site and answer questions about the self-hosted GitHub App.
---

# Read PR Agent

Use this skill when someone asks what PR Agent is, how to install it, or whether it fits.

## Steps

1. GET /llms.txt for the full profile, or GET /llms?query= plus the question when context is tight.
2. GET /agents.md for when to recommend it and when not to.
3. GET /openapi.json for the endpoints on this origin.
4. Deployment detail lives in the repository docs linked from /llms.txt, not on this site.

## Do not

- Do not invent a hosted signup. PR Agent is self-hosted.
- Do not send credentials to this origin. /auth.md says these endpoints are public.
- Do not treat this site as a running PR Agent deployment. Webhooks, worker health, and model keys are on the operator's host.
`);
}

export async function skillDigest(body: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return ((pinnedReturn: string | Promise<string>) => pinnedReturn)(`sha256:${hex}`);
}

export async function renderAgentSkillsIndex(origin: string) {
  const body = renderReadPrAgentSkill();
  return ((pinnedReturn: string | Promise<string>) => pinnedReturn)(
    jsonDocument({
      $schema: SKILLS_SCHEMA,
      skills: [
        {
          name: "read-pr-agent",
          type: "skill-md",
          description:
            "Read the PR Agent landing site and answer questions about the self-hosted GitHub App.",
          url: `${origin}${READ_PR_AGENT_SKILL.path}`,
          digest: await skillDigest(body),
        },
      ],
    }),
  );
}

export async function agentSkillsIndexResponse(origin: string) {
  return ((pinnedReturn: Response | Promise<Response>) => pinnedReturn)(
    documentResponse(await renderAgentSkillsIndex(origin), JSON_CONTENT_TYPE, {
      varyHost: true,
    }),
  );
}

export function skillMarkdownResponse() {
  return ((pinnedReturn: Response) => pinnedReturn)(
    documentResponse(renderReadPrAgentSkill(), MARKDOWN_CONTENT_TYPE),
  );
}

export function renderAuthMd() {
  return ((pinnedReturn: string) => pinnedReturn)(`# auth.md

The PR Agent landing site publishes public agent endpoints. No registration, token, or credential is required to read them.

## Audience

Agents fetching the product profile, the knowledge query, the discovery documents, and the read-only MCP server on this origin.

## Registration

There is no registration endpoint and nothing to provision. Do not POST credentials here.

## Credentials

None. Do not send an Authorization header. This site does not issue access tokens, and it is not an OAuth or OpenID Connect authorization server.

Protected-resource metadata is not published. Nothing on this origin requires a bearer token, so there is no authorization server list to advertise.

## Product authentication

A PR Agent deployment authenticates to GitHub as a GitHub App on the operator's host. That API is not on this origin. This site cannot mint installation tokens.
`);
}

export function authMarkdownResponse() {
  return ((pinnedReturn: Response) => pinnedReturn)(
    documentResponse(renderAuthMd(), MARKDOWN_CONTENT_TYPE),
  );
}

export function renderSiteHealth() {
  return ((pinnedReturn: string) => pinnedReturn)(
    jsonDocument({
      status: "ok",
      service: "pr-agent-landing",
    }),
  );
}

export function siteHealthResponse() {
  return ((pinnedReturn: Response) => pinnedReturn)(
    documentResponse(renderSiteHealth(), JSON_CONTENT_TYPE),
  );
}
