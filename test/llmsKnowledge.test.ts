import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LLMS_TXT_MISMATCH,
  llmsTxtBuildPlugin,
  llmsTxtServePlugin,
} from "../site/lib/llmsTxtPlugins.js";
import { AGENT_RESOURCES, DOC_LINKS } from "../site/lib/agentResources.js";
import {
  readEntry,
  REVISION_IDS,
  entityTag,
  lastmodForSitemapPath,
  revisionFor,
  sitemapRevision,
} from "../site/lib/contentRevision.js";
import { contentRevisionBuildPlugin } from "../site/lib/contentRevisionPlugin.js";
import {
  CONTENT_REVISION_HOST,
  CONTENT_REVISION_MISMATCH,
  redactOrigin,
  revisionHashes,
  stableDocumentBodies,
} from "../site/lib/contentRevisionCheck.js";
import { renderSitemapXml } from "../site/lib/discovery.js";
import { FETCH_MARKDOWN_LANGUAGES } from "../site/lib/content.js";
import {
  FEATURE_KEYS,
  KNOWLEDGE_CHUNKS,
  LLMS_TXT_TOKEN_ESTIMATE,
  MAX_HITS,
  MAX_QUERY_CHARS,
  answerAgentQuery,
  llmsNudgeTitle,
  parseAgentQuery,
  renderAnswerJson,
  renderAnswerText,
  renderLlmsTxt,
} from "../site/lib/llmsKnowledge.js";
import { SITE_ORIGIN } from "../site/lib/site.js";

describe("parseAgentQuery", () => {
  it("treats blank and stop-word input as empty", () => {
    expect(parseAgentQuery("")).toEqual({ kind: "empty" });
    expect(parseAgentQuery("   ")).toEqual({ kind: "empty" });
    expect(parseAgentQuery("the and of")).toEqual({ kind: "empty" });
  });

  it("treats all/everything/full/profile as broad", () => {
    expect(parseAgentQuery("everything")).toEqual({ kind: "broad", raw: "everything" });
    expect(parseAgentQuery("full profile")).toEqual({ kind: "broad", raw: "full profile" });
  });

  it("keeps mixed queries as terms when a non-broad token is present", () => {
    expect(parseAgentQuery("about pricing")).toMatchObject({
      kind: "terms",
      tokens: ["about", "pricing"],
    });
    expect(parseAgentQuery("profile deploy")).toMatchObject({
      kind: "terms",
      tokens: ["profile", "deploy"],
    });
  });

  it("clips raw input at MAX_QUERY_CHARS", () => {
    const prefix = "x".repeat(MAX_QUERY_CHARS);
    const over = `${prefix} deploy`;
    const parsed = parseAgentQuery(over);
    expect(parsed.kind).toBe("terms");
    if (parsed.kind !== "terms") {
      return;
    }
    expect(parsed.raw.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(parsed.tokens).not.toContain("deploy");
    expect(parseAgentQuery(`${prefix}everything`).kind).toBe("terms");
    expect(parseAgentQuery(prefix).kind).toBe("terms");
  });

  it("strips control characters from echoed raw", () => {
    const parsed = parseAgentQuery("deploy\n\n## Fake Heading");
    expect(parsed.kind).toBe("terms");
    if (parsed.kind !== "terms") {
      return;
    }
    expect(parsed.raw).toBe("deploy ## Fake Heading");
    expect(parsed.raw).not.toMatch(/[\r\n]/);
    const text = renderAnswerText(answerAgentQuery(parsed));
    expect(text.startsWith("# query: deploy ## Fake Heading\n")).toBe(true);
    expect(text).not.toContain("\n## Fake Heading");
  });

  it("keeps specific tokens", () => {
    expect(parseAgentQuery("How do I deploy?")).toEqual({
      kind: "terms",
      raw: "How do I deploy?",
      tokens: ["how", "do", "i", "deploy"],
    });
  });
});

describe("answerAgentQuery", () => {
  it("returns the topic index for empty and unmatched queries", () => {
    expect(answerAgentQuery({ kind: "empty" })).toEqual({ kind: "index" });
    expect(
      answerAgentQuery({ kind: "terms", raw: "zzzz-not-a-topic", tokens: ["zzzz-not-a-topic"] }),
    ).toEqual({ kind: "index" });
  });

  it("returns the full profile for broad queries", () => {
    expect(answerAgentQuery({ kind: "broad", raw: "all" })).toEqual({ kind: "full", raw: "all" });
    expect(renderAnswerText({ kind: "full", raw: "all" })).toBe(renderLlmsTxt());
  });

  it("ranks deploy above unrelated sections", () => {
    const answer = answerAgentQuery({
      kind: "terms",
      raw: "deploy docker compose",
      tokens: ["deploy", "docker", "compose"],
    });
    expect(answer.kind).toBe("hits");
    if (answer.kind !== "hits") {
      return;
    }
    expect(answer.hits[0]?.chunk.id).toBe("deploy");
    expect(answer.hits.some((hit) => hit.chunk.id === "pricing")).toBe(false);
  });

  it("ranks slash commands for a /review question", () => {
    const answer = answerAgentQuery({
      kind: "terms",
      raw: "slash command /review",
      tokens: ["slash", "command", "review"],
    });
    expect(answer.kind).toBe("hits");
    if (answer.kind !== "hits") {
      return;
    }
    expect(answer.hits[0]?.chunk.id).toBe("commands");
  });

  it("caps hits at MAX_HITS and breaks score ties by chunk id", () => {
    const answer = answerAgentQuery({
      kind: "terms",
      raw: "wide",
      tokens: ["review", "github", "agent", "feature", "command", "deploy", "price"],
    });
    expect(answer.kind).toBe("hits");
    if (answer.kind !== "hits") {
      return;
    }
    expect(answer.hits.length).toBe(MAX_HITS);
    expect(answer.hits.length).toBeLessThan(KNOWLEDGE_CHUNKS.length);
    const scores = answer.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].toSorted((left, right) => right - left));
    const tied = answer.hits.filter((hit) => hit.score === answer.hits[0]?.score);
    const tiedIds = tied.map((hit) => hit.chunk.id);
    expect(tiedIds).toEqual([...tiedIds].toSorted((left, right) => left.localeCompare(right)));
  });
});

describe("offering layer documents", () => {
  it("keeps public/llms.txt identical to the rendered corpus", () => {
    const onDisk = fs.readFileSync(path.join(process.cwd(), "site/public/llms.txt"), "utf8");
    expect(onDisk).toBe(renderLlmsTxt());
  });

  it("renders no absolute site origin, so any machine builds the same committed file", () => {
    const text = renderLlmsTxt();
    expect(text).not.toContain(SITE_ORIGIN);
    expect(text).not.toContain("localhost");
    expect(text).not.toContain(".vercel.app");
  });

  it("names every FEATURE_* key in llms.txt", () => {
    const text = renderLlmsTxt();
    for (const key of FEATURE_KEYS) {
      expect(text.includes(key), `missing ${key}`).toBe(true);
    }
  });

  it("advertises both query endpoints and a token estimate", () => {
    const text = renderLlmsTxt();
    expect(text).toContain("GET /llms?query=");
    expect(text).toContain("GET /llms/json?query=");
    expect(LLMS_TXT_TOKEN_ESTIMATE).toBeGreaterThan(200);
    expect(llmsNudgeTitle()).toContain(`~${LLMS_TXT_TOKEN_ESTIMATE} tokens`);
    expect(llmsNudgeTitle()).toContain("/llms.txt");
    expect(llmsNudgeTitle()).toContain("/llms?query=");
    expect(llmsNudgeTitle()).toContain("/llms/json?query=");
  });

  it("keeps one chunk per topic", () => {
    const ids = KNOWLEDGE_CHUNKS.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("overview");
    expect(ids).toContain("deploy");
  });

  it("tells an agent when to reach for PR Agent and when not to", () => {
    const text = renderLlmsTxt();
    expect(text).toContain("## When to use PR Agent");
    expect(text).toContain("Best-fit jobs:");
    expect(text).toContain("Do not recommend PR Agent when:");
    expect(text).toContain("GitLab or Bitbucket");
    expect(text).toContain("How an agent should call this site:");
  });

  it("documents the Accept-Language convention and the served languages", () => {
    const text = renderLlmsTxt();
    expect(text).toContain("Accept-Language: en-us, python");
    expect(text).toContain("Vary: Accept, Accept-Language");
    expect(text).toContain(
      "/index.md serves the markdown at a fixed URL with Vary: Accept-Language",
    );
    expect(text).toContain(`Served languages are ${FETCH_MARKDOWN_LANGUAGES.join(", ")}.`);
    expect(text).not.toContain("serves the same bytes");
  });

  it("answers a when-to-use question with that section", () => {
    const answer = answerAgentQuery(parseAgentQuery("when should I use this"));
    expect(answer.kind).toBe("hits");
    if (answer.kind !== "hits") {
      return;
    }
    expect(answer.hits[0]?.chunk.id).toBe("when-to-use");
  });

  it("lists the developer resources as markdown links", () => {
    const text = renderLlmsTxt();
    expect(text).toContain("## Developer resources");
    const links = AGENT_RESOURCES.map((resource) => `- [${resource.path}](${resource.path})`);
    expect(links.filter((link) => !text.includes(link))).toEqual([]);
  });

  it("answers an openapi question with the resources section", () => {
    const answer = answerAgentQuery(parseAgentQuery("openapi spec"));
    expect(answer.kind).toBe("hits");
    if (answer.kind !== "hits") {
      return;
    }
    expect(answer.hits[0]?.chunk.id).toBe("resources");
  });

  it("links the repository docs by name instead of bare URLs", () => {
    const text = renderLlmsTxt();
    expect(text).toContain("## Documentation");
    const links = DOC_LINKS.map((doc) => `- [${doc.title}](${doc.url})`);
    expect(links.filter((link) => !text.includes(link))).toEqual([]);
  });

  it("emits JSON matches for a priced query", () => {
    const json = renderAnswerJson(
      answerAgentQuery({ kind: "terms", raw: "pricing", tokens: ["pricing"] }),
    );
    expect(json.mode).toBe("hits");
    expect(json.matches.some((match) => match.id === "pricing")).toBe(true);
    expect(json.tokenEstimate).toBe(LLMS_TXT_TOKEN_ESTIMATE);
  });

  it("fails the build when committed llms.txt disagrees and does not rewrite it", () => {
    const writeFileSync = vi.fn();
    const plugin = llmsTxtBuildPlugin({
      readFileSync: (() => "stale") as unknown as typeof fs.readFileSync,
      writeFileSync,
      render: () => "fresh",
    });
    expect(plugin.apply).toBe("build");
    expect(plugin.configureServer).toBeUndefined();
    const start = plugin.buildStart;
    if (typeof start !== "function") {
      throw new Error("buildStart missing");
    }
    expect(() => start.call({} as never, {} as never)).toThrow(LLMS_TXT_MISMATCH);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("accepts a committed llms.txt that matches the renderer", () => {
    const writeFileSync = vi.fn();
    const plugin = llmsTxtBuildPlugin({
      readFileSync: (() => "fresh") as unknown as typeof fs.readFileSync,
      writeFileSync,
      render: () => "fresh",
    });
    const start = plugin.buildStart;
    if (typeof start !== "function") {
      throw new Error("buildStart missing");
    }
    expect(() => start.call({} as never, {} as never)).not.toThrow();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("rewrites llms.txt in dev and stays off the production build", () => {
    const writes: string[] = [];
    const plugin = llmsTxtServePlugin({
      writeFileSync: (_path, data) => {
        writes.push(String(data));
      },
      render: () => "rendered",
    });
    expect(plugin.apply).toBe("serve");
    expect(plugin.buildStart).toBeUndefined();
    const configure = plugin.configureServer;
    if (typeof configure !== "function") {
      throw new Error("configureServer missing");
    }
    const watched: string[] = [];
    const changes: Array<(file: string) => void> = [];
    configure.call(
      {} as never,
      {
        watcher: {
          add(files: string | readonly string[]) {
            watched.push(...(Array.isArray(files) ? files : [files]));
          },
          on(event: string, cb: (file: string) => void) {
            if (event === "change") changes.push(cb);
          },
        },
      } as never,
    );
    expect(writes).toEqual(["rendered"]);
    expect(watched.length).toBeGreaterThan(0);
    changes[0]?.(watched[0] ?? "");
    expect(writes).toEqual(["rendered", "rendered"]);
    changes[0]?.("/tmp/unrelated.ts");
    expect(writes).toEqual(["rendered", "rendered"]);
  });

  it("emits an index payload when query is empty", () => {
    const json = renderAnswerJson({ kind: "index" });
    expect(json.mode).toBe("index");
    expect(json.matches).toEqual([]);
    expect(json.topics).toEqual(KNOWLEDGE_CHUNKS.map((chunk) => chunk.id));
    expect(renderAnswerText({ kind: "index" })).toContain("Topics:");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordedHash(value: unknown, id: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const entry = value[id];
  if (!isRecord(entry)) {
    return undefined;
  }
  return entry.hash;
}

describe("content revision stamp", () => {
  it("redacts the site host so a laptop and Vercel hash the same bytes", () => {
    const local = redactOrigin("see http://localhost:3000/ today", "http://localhost:3000");
    const vercel = redactOrigin(
      "see https://pr-agent-site.vercel.app/ today",
      "https://pr-agent-site.vercel.app",
    );
    expect(local).toBe(vercel);
    expect(local).not.toContain("localhost");
    expect(vercel).not.toContain(".vercel.app");
    const bodies = stableDocumentBodies();
    for (const body of Object.values(bodies)) {
      expect(body).not.toContain("localhost");
      expect(body).not.toContain(".vercel.app");
      expect(body).not.toContain(SITE_ORIGIN);
    }
  });

  it("keeps content-revision.json aligned with those bytes", () => {
    const onDisk: unknown = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "site/content-revision.json"), "utf8"),
    );
    const hashes = revisionHashes();
    expect(recordedHash(onDisk, "landing")).toBe(hashes.landing);
    expect(recordedHash(onDisk, "llms")).toBe(hashes.llms);
    expect(recordedHash(onDisk, "agents")).toBe(hashes.agents);
    expect(recordedHash(onDisk, "openapi")).toBe(hashes.openapi);
  });

  it("rejects a stamp hash that could break an ETag header", () => {
    const revisedAt = "2026-10-01T00:00:00.000Z";
    expect(() => readEntry({ hash: 'a"\r\nX-Injected: x', revisedAt }, "landing")).toThrow(
      "content revision landing is invalid",
    );
    const hash = "a".repeat(64);
    expect(readEntry({ hash, revisedAt }, "landing").hash).toBe(hash);
    expect(entityTag(hash)).toBe(`"${hash}"`);
    expect(entityTag(hash, "typescript")).toBe(`"${hash}-typescript"`);
    expect(() => entityTag('a"\r\nX-Injected: x')).toThrow("content revision hash is not sha256");
    expect(() => entityTag(hash, 'ts"\r\nX-Injected: x')).toThrow(
      "content revision variant is not a token",
    );
  });

  it("fails the build when a body still names a site host", () => {
    const clean = stableDocumentBodies();
    const plugin = contentRevisionBuildPlugin({
      bodies: () => ({ ...clean, landing: `${clean.landing}\nhttp://localhost:3000/` }),
    });
    const start = plugin.buildStart;
    expect(typeof start).toBe("function");
    if (typeof start !== "function") {
      return;
    }
    expect(start).toThrow(CONTENT_REVISION_HOST);
  });

  it("fails the build when a sitemap path has no revision", () => {
    const plugin = contentRevisionBuildPlugin({
      bodies: () => stableDocumentBodies(),
      sitemapResources: [{ path: "/not-a-page", inSitemap: true }],
    });
    const start = plugin.buildStart;
    expect(typeof start).toBe("function");
    if (typeof start !== "function") {
      return;
    }
    expect(start).toThrow("no content revision for /not-a-page");
  });

  it("fails the build when the stamp omits a document", () => {
    const plugin = contentRevisionBuildPlugin({
      readStamp: () => "{}",
      bodies: () => stableDocumentBodies(),
    });
    const start = plugin.buildStart;
    expect(typeof start).toBe("function");
    if (typeof start !== "function") {
      return;
    }
    expect(start).toThrow(CONTENT_REVISION_MISMATCH);
  });

  it("renders each sitemap url from its revision and joins hashes in id order", () => {
    const seen: string[] = [];
    const xml = renderSitemapXml((path) => {
      seen.push(path);
      return lastmodForSitemapPath(path);
    });
    const expected = AGENT_RESOURCES.filter((resource) => resource.inSitemap).map(
      (resource) => resource.path,
    );
    expect(seen).toEqual(expected);
    for (const path of expected) {
      expect(xml).toContain(`<lastmod>${lastmodForSitemapPath(path)}</lastmod>`);
      expect(xml).toContain(`<loc>${SITE_ORIGIN}${path}</loc>`);
    }
    const preview = renderSitemapXml(
      (path) => lastmodForSitemapPath(path),
      "https://preview.example",
    );
    expect(preview).toContain("<loc>https://preview.example/</loc>");
    expect(preview).not.toContain(SITE_ORIGIN);
    expect(() => lastmodForSitemapPath("/not-a-page")).toThrow(
      "no content revision for /not-a-page",
    );
    expect(sitemapRevision().hash).toBe(REVISION_IDS.map((id) => revisionFor(id).hash).join(""));
  });

  it("fails the build when the stamp disagrees and does not rewrite it", () => {
    const readStamp = vi.fn(() => '{"landing":{"hash":"nope"}}');
    const plugin = contentRevisionBuildPlugin({
      readStamp,
      bodies: () => stableDocumentBodies(),
    });
    expect(plugin.apply).toBe("build");
    const start = plugin.buildStart;
    expect(typeof start).toBe("function");
    if (typeof start !== "function") {
      return;
    }
    expect(start).toThrow(CONTENT_REVISION_MISMATCH);
    expect(readStamp).toHaveBeenCalled();
  });
});
