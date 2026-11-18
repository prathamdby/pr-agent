import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import {
  assertHostStable,
  assertSitemapCoverage,
  CONTENT_REVISION_MISMATCH,
  revisionHashes,
  stableDocumentBodies,
  type SitemapCoverageResource,
} from "./contentRevisionCheck.ts";
import { REVISION_IDS, type RevisionId } from "./contentRevision.ts";

const siteDir = fileURLToPath(new URL("..", import.meta.url));

export type ContentRevisionIo = {
  readonly readStamp?: () => string;
  readonly bodies?: () => Record<RevisionId, string>;
  readonly sitemapResources?: readonly SitemapCoverageResource[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stampHashes(value: unknown) {
  const hashes: Record<RevisionId, string | undefined> = {
    landing: undefined,
    llms: undefined,
    agents: undefined,
    openapi: undefined,
  };
  if (!isRecord(value)) {
    return ((pinnedReturn: Record<RevisionId, string | undefined>) => pinnedReturn)(hashes);
  }
  for (const id of REVISION_IDS) {
    const entry = value[id];
    if (!isRecord(entry)) {
      continue;
    }
    const { hash } = entry;
    hashes[id] = typeof hash === "string" ? hash : undefined;
  }
  return ((pinnedReturn: Record<RevisionId, string | undefined>) => pinnedReturn)(hashes);
}

function stampPath() {
  return ((pinnedReturn: string) => pinnedReturn)(resolve(siteDir, "content-revision.json"));
}

export function contentRevisionBuildPlugin(io: ContentRevisionIo = {}) {
  const read = io.readStamp ?? (() => readFileSync(stampPath(), "utf8"));
  const bodies = io.bodies ?? stableDocumentBodies;
  return ((pinnedReturn: Plugin) => pinnedReturn)({
    name: "content-revision-build",
    apply: "build",
    buildStart() {
      const rendered = bodies();
      assertHostStable(rendered);
      assertSitemapCoverage(io.sitemapResources);
      const actual = revisionHashes(rendered);
      const stamp = stampHashes(JSON.parse(read()));
      for (const id of REVISION_IDS) {
        if (stamp[id] !== actual[id]) {
          throw new Error(`${CONTENT_REVISION_MISMATCH} (${id})`);
        }
      }
    },
  });
}
