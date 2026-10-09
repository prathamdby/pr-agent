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
  readonly readStamp?: () => string;
  readonly bodies?: () => Record<RevisionId, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stampHashes(value: unknown): Record<RevisionId, string | undefined> {
  const hashes: Record<RevisionId, string | undefined> = {
    landing: undefined,
    llms: undefined,
    agents: undefined,
    openapi: undefined,
  };
  if (!isRecord(value)) {
    return hashes;
  }
  for (const id of REVISION_IDS) {
    const entry = value[id];
    if (!isRecord(entry)) {
      continue;
    }
    const { hash } = entry;
    hashes[id] = typeof hash === "string" ? hash : undefined;
  }
  return hashes;
}

function stampPath(): string {
  return resolve(siteDir, "content-revision.json");
}

/** Production build fails when the committed stamp disagrees. It does not rewrite it. */
export function contentRevisionBuildPlugin(io: ContentRevisionIo = {}): Plugin {
  const read = io.readStamp ?? (() => readFileSync(stampPath(), "utf8"));
  const bodies = io.bodies ?? stableDocumentBodies;
  return {
    name: "content-revision-build",
    apply: "build",
    buildStart() {
      const rendered = bodies();
      assertHostStable(rendered);
      assertSitemapCoverage();
      const actual = revisionHashes(rendered);
      const stamp = stampHashes(JSON.parse(read()));
      for (const id of REVISION_IDS) {
        if (stamp[id] !== actual[id]) {
          throw new Error(`${CONTENT_REVISION_MISMATCH} (${id})`);
        }
      }
    },
  };
}
