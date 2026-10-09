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
} from "./contentRevisionCheck.js";
import { REVISION_IDS, type RevisionId } from "./contentRevision.js";

const siteDir = fileURLToPath(new URL("..", import.meta.url));

export type ContentRevisionIo = {
  readonly readFileSync?: typeof readFileSync;
  readonly bodies?: () => Record<RevisionId, string>;
};

function stampHashes(value: unknown): Record<RevisionId, string | undefined> {
  const hashes: Record<RevisionId, string | undefined> = {
    landing: undefined,
    llms: undefined,
    agents: undefined,
    openapi: undefined,
  };
  if (typeof value !== "object" || value === null) {
    return hashes;
  }
  for (const id of REVISION_IDS) {
    if (!(id in value)) {
      continue;
    }
    const entry = value[id];
    if (typeof entry !== "object" || entry === null || !("hash" in entry)) {
      continue;
    }
    hashes[id] = typeof entry.hash === "string" ? entry.hash : undefined;
  }
  return hashes;
}

function stampPath(): string {
  return resolve(siteDir, "content-revision.json");
}

/** Production build fails when the committed stamp disagrees. It does not rewrite it. */
export function contentRevisionBuildPlugin(io: ContentRevisionIo = {}): Plugin {
  const read = io.readFileSync ?? readFileSync;
  const bodies = io.bodies ?? stableDocumentBodies;
  return {
    name: "content-revision-build",
    apply: "build",
    buildStart() {
      const rendered = bodies();
      assertHostStable(rendered);
      assertSitemapCoverage();
      const actual = revisionHashes(rendered);
      const stamp = stampHashes(JSON.parse(read(stampPath(), "utf8")));
      for (const id of REVISION_IDS) {
        if (stamp[id] !== actual[id]) {
          throw new Error(`${CONTENT_REVISION_MISMATCH} (${id})`);
        }
      }
    },
  };
}
