import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FEATURE_KEYS,
  KNOWLEDGE_CHUNKS,
  LLMS_TXT_TOKEN_ESTIMATE,
  answerAgentQuery,
  llmsNudgeTitle,
  parseAgentQuery,
  renderAnswerJson,
  renderAnswerText,
  renderLlmsTxt,
} from "../site/lib/llmsKnowledge.js";

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
});

describe("offering layer documents", () => {
  it("keeps public/llms.txt identical to the rendered corpus", () => {
    const onDisk = fs.readFileSync(path.join(process.cwd(), "site/public/llms.txt"), "utf8");
    expect(onDisk).toBe(renderLlmsTxt());
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
