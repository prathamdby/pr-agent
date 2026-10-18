import { createHash } from "node:crypto";
import { AGENT_RESOURCES } from "./agentResources.ts";
import { FETCH_MARKDOWN_LANGUAGES } from "./content.ts";
import { lastmodForSitemapPath, REVISION_IDS, type RevisionId } from "./contentRevision.ts";
import { renderLlmsTxt } from "./llmsKnowledge.ts";
import { renderOpenApiDocument } from "./openapi.ts";
import { renderAgentInstructionsMarkdown, renderHomeMarkdown } from "./pageMarkdown.ts";
import { SITE_ORIGIN } from "./site.ts";

export const ORIGIN_TOKEN = "https://origin.invalid";

export const CONTENT_REVISION_MISMATCH =
  "site/content-revision.json does not match the rendered documents";

export const CONTENT_REVISION_HOST = "content revision hash input contains a site host";

export function redactOrigin(body: string, origin: string): string {
  return body.split(origin).join(ORIGIN_TOKEN);
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function stableDocumentBodies(): Record<RevisionId, string> {
  const landing = FETCH_MARKDOWN_LANGUAGES.map((language) =>
    redactOrigin(renderHomeMarkdown(language), SITE_ORIGIN),
  ).join("\n");
  return {
    landing,
    llms: renderLlmsTxt(),
    agents: renderAgentInstructionsMarkdown(),
    openapi: redactOrigin(JSON.stringify(renderOpenApiDocument()), SITE_ORIGIN),
  };
}

export function revisionHashes(
  bodies: Record<RevisionId, string> = stableDocumentBodies(),
): Record<RevisionId, string> {
  return {
    landing: sha256(bodies.landing),
    llms: sha256(bodies.llms),
    agents: sha256(bodies.agents),
    openapi: sha256(bodies.openapi),
  };
}

export function assertHostStable(bodies: Record<RevisionId, string>): void {
  for (const id of REVISION_IDS) {
    const body = bodies[id];
    if (body.includes("localhost") || body.includes(".vercel.app") || body.includes(SITE_ORIGIN)) {
      throw new Error(`${CONTENT_REVISION_HOST} (${id})`);
    }
  }
}

export type SitemapCoverageResource = {
  readonly path: string;
  readonly inSitemap: boolean;
};

export function assertSitemapCoverage(
  resources: readonly SitemapCoverageResource[] = AGENT_RESOURCES,
): void {
  for (const resource of resources) {
    if (resource.inSitemap) {
      lastmodForSitemapPath(resource.path);
    }
  }
}
