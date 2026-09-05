import { describe, expect, it } from "vitest";
import { llmsQueryResponse } from "../site/lib/llmsHttp.js";
import { renderLlmsTxt } from "../site/lib/llmsKnowledge.js";

function header(response: Response, name: string): string | null {
  return response.headers.get(name);
}

describe("llmsQueryResponse", () => {
  it("returns the topic index for a missing query", async () => {
    const response = llmsQueryResponse(new Request("http://test/llms"), "text");
    expect(response.status).toBe(200);
    expect(header(response, "content-type")).toBe("text/plain; charset=utf-8");
    expect(header(response, "cache-control")).toBe("public, max-age=300");
    expect(header(response, "x-content-type-options")).toBe("nosniff");
    const body = await response.text();
    expect(body).toContain("Topics:");
    expect(body).toContain("deploy:");
  });

  it("returns deploy hits for a text query", async () => {
    const response = llmsQueryResponse(new Request("http://test/llms?query=deploy"), "text");
    expect(response.status).toBe(200);
    expect(header(response, "content-type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("# query: deploy");
    expect(body).toContain("## Deploy with Docker Compose");
  });

  it("returns JSON hits and headers for a faq query", async () => {
    const response = llmsQueryResponse(new Request("http://test/llms/json?query=faq"), "json");
    expect(response.status).toBe(200);
    expect(header(response, "content-type")).toBe("application/json; charset=utf-8");
    expect(header(response, "cache-control")).toBe("public, max-age=300");
    expect(header(response, "x-content-type-options")).toBe("nosniff");
    const body = (await response.json()) as { mode: string; matches: { id: string }[] };
    expect(body.mode).toBe("hits");
    expect(body.matches.some((match) => match.id === "faq")).toBe(true);
  });

  it("decodes plus-encoded query values", async () => {
    const response = llmsQueryResponse(new Request("http://test/llms?query=slash+command"), "text");
    const body = await response.text();
    expect(body).toContain("# query: slash command");
    expect(body).toContain("## Slash commands");
  });
});

describe("renderLlmsTxt", () => {
  it("renders the full profile", () => {
    const body = renderLlmsTxt();
    expect(body.startsWith("# PR Agent")).toBe(true);
    expect(body).toContain("FEATURE_REVIEW");
  });
});
