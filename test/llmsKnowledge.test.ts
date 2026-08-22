import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_RESOURCES, DOC_LINKS } from "../site/lib/agentResources.js";
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

  it("emits an index payload when query is empty", () => {
    const json = renderAnswerJson({ kind: "index" });
    expect(json.mode).toBe("index");
    expect(json.matches).toEqual([]);
    expect(json.topics).toEqual(KNOWLEDGE_CHUNKS.map((chunk) => chunk.id));
    expect(renderAnswerText({ kind: "index" })).toContain("Topics:");
  });
});
